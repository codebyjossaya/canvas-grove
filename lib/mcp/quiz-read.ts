import "server-only";
import type { AuthContext } from "@/lib/db/auth-context";
import { canvasApiForSession, hostedSessionStore } from "@/lib/bridge/hosted-browser";
import { BridgeError } from "@/lib/bridge/errors";
import { healthEventRow } from "@/lib/canvas/session-health";
import type { CanvasApiResult } from "@/lib/canvas/session-client";
import { isRecord, quizFailure } from "@/lib/quizzes/contracts";
import { QuizServiceError, type getCurrentAttempt } from "@/lib/quizzes/service";
import { readModel, type ReadQuestion } from "./quiz-format";
import type { QuizRecord } from "./quiz-core";

// Read-only attempt loading for get_quiz_question. GET requests only: it never starts, saves or
// submits anything. One Canvas session lookup, one cookie-jar client, one rotation flush and one
// health row per tool call (the quiz service pays these per request), and the attempt state is
// read once (the old path read it twice and the timer twice, in four serial round trips).

export type QuizCanvas = { origin: string; get(path: string): Promise<CanvasApiResult> };

/** Runs `work` with one Canvas client for the owner's active session. */
export async function withQuizCanvas<T>(ctx: AuthContext, work: (canvas: QuizCanvas) => Promise<T>): Promise<T> {
  const sessions = await hostedSessionStore.listForOwner(ctx.clerkUserId);
  const session = sessions.find((item) => item.state === "active");
  if (!session) throw new QuizServiceError("CANVAS_AUTH_EXPIRED", "Reconnect Canvas before using Quiz Mode.", 401);
  const client = canvasApiForSession(session, ctx.clerkUserId);
  let expired = false;
  const canvas: QuizCanvas = {
    origin: session.canvasOrigin,
    async get(path) {
      let result: CanvasApiResult;
      try { result = await client.request({ method: "GET", path }); }
      catch (error) {
        if (error instanceof BridgeError && error.code === "CANVAS_SESSION_EXPIRED") throw new QuizServiceError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas, then return to the quiz.", 401);
        throw error;
      }
      if (result.authRequired && !expired) {
        expired = true;
        await hostedSessionStore.updateForOwner(session.id, ctx.clerkUserId, { state: "auth-expired", lastError: "CANVAS_SESSION_EXPIRED" });
      }
      if (!result.ok) { const failure = quizFailure(result.status, result.authRequired); throw new QuizServiceError(failure.code, failure.error, failure.status); }
      return result;
    },
  };
  try { return await work(canvas); }
  finally {
    await client.flush().catch(() => undefined);
    const row = healthEventRow(client.stats(), { ownerId: session.userId, hostedSessionId: session.id, kind: "api" });
    if (row) await hostedSessionStore.recordHealthEvent(session.id, ctx.clerkUserId, row).catch(() => undefined);
  }
}

const canvasId = (value: string) => {
  if (!/^\d{1,20}$/.test(value)) throw new QuizServiceError("INVALID_CANVAS_ID", "Canvas returned an invalid quiz identifier.");
  return value;
};

// Mirrors the quiz service's attempt selection (service.ts firstSubmission / isActiveSubmission).
export function isActiveSubmission(value: Record<string, unknown> | null) {
  const state = String(value?.workflow_state ?? "");
  return Boolean(value?.id && !value.finished_at && !["complete", "pending_review"].includes(state) && (value.started_at || state === "untaken"));
}
export function currentSubmission(data: unknown): Record<string, unknown> | null {
  const rows = isRecord(data) && Array.isArray(data.quiz_submissions) ? data.quiz_submissions.filter(isRecord) : [];
  return rows.sort((a, b) => Number(isActiveSubmission(b)) - Number(isActiveSubmission(a)) || Number(b.attempt ?? 0) - Number(a.attempt ?? 0))[0] ?? null;
}

export type AttemptRead = {
  submissionId: string; attempt: number; questions: ReadQuestion[];
  timing: { endAt: string | null; secondsRemaining: number | null };
  incomplete: { expected: number; returned: number } | null;
};

/** Questions + timer of one known submission: the question pages and the timer load in parallel. */
export async function readSubmission(canvas: QuizCanvas, quiz: Pick<QuizRecord, "canvas_course_id" | "canvas_quiz_id" | "question_count">, submission: Record<string, unknown>): Promise<AttemptRead> {
  const submissionId = canvasId(String(submission.id ?? ""));
  const pages = async () => {
    const records: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 10; page += 1) {
      const result = await canvas.get(`/api/v1/quiz_submissions/${submissionId}/questions?include[]=quiz_question&per_page=100&page=${page}`);
      const rows = isRecord(result.data) ? result.data.quiz_submission_questions : null;
      if (!Array.isArray(rows)) throw new QuizServiceError("QUIZ_QUESTIONS_INVALID", "Canvas returned an invalid question list. Open this quiz in Canvas.", 502);
      for (const row of rows.filter(isRecord)) { const id = String(row.id ?? ""); if (id && !seen.has(id)) { seen.add(id); records.push(row); } }
      if (rows.length < 100 || (quiz.question_count != null && records.length >= quiz.question_count)) break;
    }
    return records;
  };
  const [questions, time] = await Promise.all([
    pages(),
    canvas.get(`/api/v1/courses/${canvasId(quiz.canvas_course_id)}/quizzes/${canvasId(quiz.canvas_quiz_id)}/submissions/${submissionId}/time`).then((r) => (isRecord(r.data) ? r.data : null), () => null),
  ]);
  const left = Number(time?.time_left);
  const endAt = typeof time?.end_at === "string" ? time.end_at : typeof submission.end_at === "string" ? submission.end_at : null;
  return {
    submissionId, attempt: Number(submission.attempt ?? 0), questions: readModel(questions),
    timing: { endAt, secondsRemaining: time?.time_left == null || !Number.isFinite(left) ? null : left },
    incomplete: quiz.question_count != null && questions.length < quiz.question_count ? { expected: quiz.question_count, returned: questions.length } : null,
  };
}

export const isOneQuestionAtATime = (quiz: Pick<QuizRecord, "source_payload">) => isRecord(quiz.source_payload) && quiz.source_payload.oneQuestionAtATime === true;

/** One-question-at-a-time attempts load through Grove's quiz service (Canvas's own player pages); this adapts its bundle. */
export function fromNativeBundle(bundle: Awaited<ReturnType<typeof getCurrentAttempt>>): AttemptRead {
  if (!bundle.nativeSupported) throw new QuizServiceError(bundle.nativeBlock?.code ?? "QUIZ_NATIVE_BLOCKED", bundle.nativeBlock?.message ?? "This attempt must be finished in Canvas.", 409);
  return {
    submissionId: String(bundle.attempt.id), attempt: bundle.attempt.attempt,
    questions: bundle.questions.map((question) => ({ ...question, answerable: true, reason: null })),
    timing: { endAt: typeof bundle.timing.expiresAt === "string" ? bundle.timing.expiresAt : null, secondsRemaining: bundle.timing.secondsRemaining },
    incomplete: null,
  };
}

/** The owner's active (REST-paged) attempt of `quiz`, read-only, with every question (unsupported ones marked). */
export async function readCurrentAttempt(ctx: AuthContext, quiz: QuizRecord): Promise<AttemptRead> {
  return withQuizCanvas(ctx, async (canvas) => {
    const state = await canvas.get(`/api/v1/courses/${canvasId(quiz.canvas_course_id)}/quizzes/${canvasId(quiz.canvas_quiz_id)}/submission`);
    const submission = currentSubmission(state.data);
    if (!submission || !isActiveSubmission(submission)) throw new QuizServiceError("NO_ACTIVE_ATTEMPT", "There is no active Canvas attempt to resume.", 404);
    return readSubmission(canvas, quiz, submission);
  });
}
