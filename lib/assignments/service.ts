import "server-only";
import { withTenantSql } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { executeCanvasApiForSession, executeInHostedSession, hostedSessionStore, replayInHostedSession, type HostedExecutionResult, type HostedSession } from "@/lib/bridge/hosted-browser";
import { BridgeError } from "@/lib/bridge/errors";
import {
  AssignmentSubmissionInputError,
  assertLiveAssignmentAllows,
  assignmentPreflightPath,
  assignmentSubmissionRequest,
  isRecord,
  submissionFailure,
  type AssignmentSubmissionInput,
} from "./contracts";

type AssignmentRow = {
  id: string; canvas_assignment_id: string; canvas_course_id: string; canvas_account_id: string; canvas_base_url: string;
};

export type AssignmentSubmissionReceipt = {
  submitted: true; replay: boolean; assignmentId: string; canvasSubmissionId: string | null;
  attempt: number | null; state: string | null; submittedAt: string | null; warnings: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown) => typeof value === "string" && value ? value : value == null ? null : String(value);
const finiteInt = (value: unknown) => value != null && value !== "" && Number.isInteger(Number(value)) ? Number(value) : null;
const finiteNumber = (value: unknown) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const date = (value: unknown) => { if (typeof value !== "string") return null; const at = new Date(value); return Number.isFinite(at.getTime()) ? at : null; };

async function loadAssignment(ctx: AuthContext, assignmentId: string): Promise<AssignmentRow> {
  if (!UUID.test(assignmentId)) throw new AssignmentSubmissionInputError("ASSIGNMENT_NOT_FOUND", "Assignment not found.", 404);
  const [row] = await withTenantSql(ctx.ownerId, (tx) => tx<AssignmentRow[]>`
    select a.id, a.canvas_assignment_id,
      c.canvas_course_id, c.canvas_account_id, ca.canvas_base_url
    from assignments a
    join courses c on c.owner_id = a.owner_id and c.id = a.course_id and c.deleted_at is null
    join canvas_accounts ca on ca.owner_id = c.owner_id and ca.id = c.canvas_account_id
    where a.owner_id = ${ctx.ownerId} and a.id = ${assignmentId} and a.deleted_at is null limit 1`);
  if (!row) throw new AssignmentSubmissionInputError("ASSIGNMENT_NOT_FOUND", "Assignment not found.", 404);
  return row;
}

async function assignmentSession(ctx: AuthContext, row: AssignmentRow): Promise<HostedSession> {
  const origin = new URL(row.canvas_base_url).origin;
  const [linked] = await withTenantSql(ctx.ownerId, (tx) => tx<{ id: string }[]>`select id from hosted_browser_sessions
    where owner_id = ${ctx.ownerId} and canvas_account_id = ${row.canvas_account_id} and status = 'active' and revoked_at is null
    order by updated_at desc limit 1`);
  const session = linked ? await hostedSessionStore.getForOwner(linked.id, ctx.clerkUserId) : null;
  if (!session || session.state !== "active" || new URL(session.canvasOrigin).origin !== origin) throw new AssignmentSubmissionInputError("CANVAS_AUTH_EXPIRED", "Reconnect this Canvas account before submitting.", 401);
  return session;
}

function canvasFailure(status: number, authRequired: boolean): never {
  const failure = submissionFailure(status, authRequired);
  throw new AssignmentSubmissionInputError(failure.code, failure.error, failure.status);
}

async function persistReceipt(ctx: AuthContext, row: AssignmentRow, session: HostedSession | null, value: Record<string, unknown>) {
  const attempt = finiteInt(value.attempt) ?? 0;
  await withTenantSql(ctx.ownerId, async (tx) => {
    await tx`insert into submissions(owner_id,assignment_id,canvas_submission_id,attempt,state,submitted_at,graded_at,score,grade,late,missing,excused,source_updated_at,synced_at,source_payload,updated_at)
      values(${ctx.ownerId},${row.id},${text(value.id)},${attempt},${text(value.workflow_state)},${date(value.submitted_at)},${date(value.graded_at)},${finiteNumber(value.score)},${text(value.grade)},${value.late === true},${value.missing === true},${value.excused === true},${date(value.updated_at)},now(),${tx.json(value)},now())
      on conflict(assignment_id,attempt) do update set canvas_submission_id=excluded.canvas_submission_id,state=excluded.state,submitted_at=excluded.submitted_at,graded_at=excluded.graded_at,score=excluded.score,grade=excluded.grade,late=excluded.late,missing=excluded.missing,excused=excluded.excused,source_updated_at=excluded.source_updated_at,synced_at=now(),source_payload=excluded.source_payload,updated_at=now()`;
    for (const kind of ["assignments", "grades"]) {
      await tx`insert into sync_jobs(owner_id,canvas_account_id,hosted_session_id,kind,scope,dedupe_key,status,priority,max_attempts,run_after)
        values(${ctx.ownerId},${row.canvas_account_id},${session?.id ?? null},${kind},${tx.json({ reason: "assignment_submitted", assignmentId: row.id })},${`assignment-submit:${row.id}:${kind}`},'queued',200,5,now()) on conflict do nothing`;
    }
  });
}

function operationError(error: unknown): never {
  if (error instanceof Error && error.message.includes("different request")) throw new AssignmentSubmissionInputError("IDEMPOTENCY_KEY_REUSED", "This retry key belongs to different submission content. Review the submission and try again.", 409);
  throw new AssignmentSubmissionInputError("SUBMISSION_STATUS_UNKNOWN", "Grove could not confirm whether Canvas received this submission. Check the assignment in Canvas before trying again.", 502);
}

async function finishReceipt(ctx: AuthContext, row: AssignmentRow, session: HostedSession | null, result: HostedExecutionResult): Promise<AssignmentSubmissionReceipt> {
  if (!result.ok) canvasFailure(result.status, result.authRequired);
  if (!isRecord(result.data)) throw new AssignmentSubmissionInputError("SUBMISSION_UNCONFIRMED", "Canvas accepted the request but did not return a submission receipt. Check Canvas before retrying.", 502);
  const warnings: string[] = [];
  try { await persistReceipt(ctx, row, session, result.data); }
  catch (error) {
    console.error("assignment_submit_receipt_persist_failed", { assignmentId: row.id, error: error instanceof Error ? error.name : "unknown" });
    warnings.push("receipt_cache_pending", "resync_pending");
  }
  return {
    submitted: true, replay: result.replay, assignmentId: row.id, canvasSubmissionId: text(result.data.id),
    attempt: finiteInt(result.data.attempt), state: text(result.data.workflow_state), submittedAt: date(result.data.submitted_at)?.toISOString() ?? null, warnings,
  };
}

/** The only live assignment-submit path used by both Grove's UI and approved MCP actions. */
export async function submitAssignment(ctx: AuthContext, assignmentId: string, input: AssignmentSubmissionInput, idempotencyKey: string): Promise<AssignmentSubmissionReceipt> {
  const row = await loadAssignment(ctx, assignmentId);
  const request = assignmentSubmissionRequest(row.canvas_course_id, row.canvas_assignment_id, input);
  // Namespace caller keys to the exact connected Canvas account. This prevents identical numeric
  // course/assignment ids at two institutions from replaying each other's receipt.
  const operationKey = `assignment:${row.canvas_account_id}:${idempotencyKey}`;
  let prior: HostedExecutionResult | null;
  try { prior = await replayInHostedSession({ ownerId: ctx.clerkUserId, idempotencyKey: operationKey, request }); }
  catch (error) { operationError(error); }
  if (prior) return finishReceipt(ctx, row, null, prior);
  const session = await assignmentSession(ctx, row);

  let preflight;
  try { preflight = await executeCanvasApiForSession(session, ctx.clerkUserId, { method: "GET", path: assignmentPreflightPath(row.canvas_course_id, row.canvas_assignment_id) }); }
  catch (error) {
    if (error instanceof BridgeError && error.code === "CANVAS_SESSION_EXPIRED") throw new AssignmentSubmissionInputError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas, then try again.", 401);
    throw error;
  }
  if (!preflight.ok) canvasFailure(preflight.status, preflight.authRequired);
  assertLiveAssignmentAllows(preflight.data, input.type);

  let result: HostedExecutionResult;
  try { result = await executeInHostedSession({ ownerId: ctx.clerkUserId, sessionId: session.id, idempotencyKey: operationKey, request }); }
  catch (error) { operationError(error); }
  return finishReceipt(ctx, row, session, result);
}
