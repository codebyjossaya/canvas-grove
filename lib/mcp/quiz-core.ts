import "server-only";
import type postgres from "postgres";
import { withTenantSql } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { QuizServiceError, getQuizPreflight, startAttempt } from "@/lib/quizzes/service";
import { quizEligibility, sessionExpiry, type Eligibility, type QuizFacts, type QuizSessionRow } from "./action-policy";
import { auditTx, type ActionRow, type ExecResult } from "./actions";

// Quiz access for assistants: technical eligibility is re-read from the DB on every call (never
// cached), with entry-scoped sessions bound to (connection, quiz, Canvas attempt).

type Tx = postgres.TransactionSql;
export type QuizRecord = QuizFacts & {
  id: string; canvas_quiz_id: string; time_limit_minutes: number | null; allowed_attempts: number | null; question_count: number | null;
  due_at: string | Date | null; lock_at: string | Date | null; locked_for_user: boolean; published: boolean; canvas_course_id: string; course_name: string;
};

const QUIZ_SELECT = (tx: Tx, ownerId: string, ref: string) => tx<QuizRecord[]>`
  select q.id, q.canvas_quiz_id, q.engine, q.quiz_type, q.points_possible, q.supported, q.title, q.description_html, q.source_payload, q.deleted_at,
    q.time_limit_minutes, q.allowed_attempts, q.question_count, q.due_at, q.lock_at, q.locked_for_user, q.published, c.canvas_course_id, c.name as course_name
  from quizzes q join courses c on c.owner_id = q.owner_id and c.id = q.course_id
  where q.owner_id = ${ownerId} and q.deleted_at is null and c.deleted_at is null and (q.id::text = ${ref.toLowerCase()} or q.canvas_quiz_id = ${ref})
  order by (q.id::text = ${ref.toLowerCase()}) desc limit 1`;

/** Fresh quiz row + eligibility. `ref` is Grove's quiz id or the Canvas quiz id. */
export async function loadQuiz(ownerId: string, ref: string): Promise<{ quiz: QuizRecord | null; eligibility: Eligibility }> {
  const [quiz] = await withTenantSql(ownerId, (tx) => QUIZ_SELECT(tx, ownerId, ref));
  return { quiz: quiz ?? null, eligibility: quizEligibility(quiz) };
}

export type ConnectionCols = { tokenId: string | null; grantId: string | null; clientName: string };
export type SessionRecord = QuizSessionRow & { id: string; action_id: string | null };

export async function openSession(ownerId: string, conn: ConnectionCols, quizId: string): Promise<SessionRecord | null> {
  const [row] = await withTenantSql(ownerId, (tx) => tx<SessionRecord[]>`select id, action_id, quiz_id, canvas_submission_id, attempt, expires_at, ended_at from mcp_quiz_sessions
    where owner_id = ${ownerId} and quiz_id = ${quizId} and token_id is not distinct from ${conn.tokenId}::uuid and grant_id is not distinct from ${conn.grantId}::uuid
      and ended_at is null order by created_at desc limit 1`);
  return row ?? null;
}

export async function endSession(ownerId: string, sessionId: string) {
  await withTenantSql(ownerId, (tx) => tx`update mcp_quiz_sessions set ended_at = now() where owner_id = ${ownerId} and id = ${sessionId} and ended_at is null`);
}

export async function auditQuiz(ownerId: string, conn: ConnectionCols, tool: string, outcome: string, actionId: string | null = null) {
  await withTenantSql(ownerId, (tx) => auditTx(tx, ownerId, { tokenId: conn.tokenId, grantId: conn.grantId, clientName: conn.clientName, tool, outcome, actionId })).catch(() => undefined);
}

const notEligible = (reason: string): ExecResult => ({ ok: false, code: "QUIZ_NOT_ELIGIBLE", message: reason });

/**
 * Executor for an approved (or auto-approved) start_quiz_attempt. Re-checks eligibility from the
 * DB, refreshes the quiz from Canvas (live preflight persists restrictions), re-checks again, then
 * starts the attempt through Grove's quiz service and opens a session for exactly that attempt.
 * Questions are never put into the action result.
 */
export async function executeStartQuiz(ctx: AuthContext, action: ActionRow): Promise<ExecResult> {
  const conn: ConnectionCols = { tokenId: action.token_id, grantId: action.grant_id, clientName: action.client_name };
  const quizId = String(action.args.quizId ?? "");
  const first = await loadQuiz(ctx.ownerId, quizId);
  if (!first.quiz || !first.eligibility.eligible) {
    await auditQuiz(ctx.ownerId, conn, "start_quiz_attempt", "blocked:not_eligible", action.id);
    return notEligible(first.eligibility.eligible ? "Quiz not found." : first.eligibility.reason);
  }
  try {
    const preflight = await getQuizPreflight(ctx, first.quiz.id, { live: true });
    const second = await loadQuiz(ctx.ownerId, first.quiz.id);
    if (!second.eligibility.eligible) {
      await auditQuiz(ctx.ownerId, conn, "start_quiz_attempt", "blocked:not_eligible", action.id);
      return notEligible(second.eligibility.reason);
    }
    if (preflight.availability.status !== "in_progress" && !preflight.availability.canStart)
      return { ok: false, code: "QUIZ_NOT_STARTABLE", message: preflight.availability.reason ?? "Canvas does not allow starting this quiz now." };
    const bundle = await startAttempt(ctx, first.quiz.id, true);
    const attempt = bundle.attempt;
    if (!/^\d{1,20}$/.test(String(attempt.id))) return { ok: false, code: "QUIZ_START_FAILED", message: "Canvas did not return a usable attempt." };
    const session = await withTenantSql(ctx.ownerId, async (tx) => {
      await tx`update mcp_quiz_sessions set ended_at = now() where owner_id = ${ctx.ownerId} and quiz_id = ${first.quiz!.id} and ended_at is null
        and token_id is not distinct from ${conn.tokenId}::uuid and grant_id is not distinct from ${conn.grantId}::uuid`;
      const [row] = await tx<{ id: string }[]>`insert into mcp_quiz_sessions (owner_id, token_id, grant_id, action_id, quiz_id, canvas_submission_id, attempt, expires_at)
        values (${ctx.ownerId}, ${conn.tokenId}, ${conn.grantId}, ${action.id}, ${first.quiz!.id}, ${String(attempt.id)}, ${attempt.attempt}, ${sessionExpiry(attempt.endAt).toISOString()}) returning id`;
      await auditTx(tx, ctx.ownerId, { tokenId: conn.tokenId, grantId: conn.grantId, clientName: conn.clientName, tool: "start_quiz_attempt", outcome: "session_opened", actionId: action.id });
      return row;
    });
    const native = bundle.nativeSupported ? "" : " Grove cannot reproduce this attempt's questions natively; it must be finished in Canvas.";
    return { ok: true, message: `Quiz attempt ${attempt.attempt} started.${native}`, data: { sessionId: session.id, attempt: attempt.attempt, quizId: first.quiz.id } };
  } catch (error) {
    if (error instanceof QuizServiceError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
