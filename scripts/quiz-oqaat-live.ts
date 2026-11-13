// Live end-to-end check of native Quiz Mode for a one-question-at-a-time Classic quiz.
// Drives lib/quizzes/service.ts (the same functions the quiz API routes call) as the
// developer's own Grove account, on ONE fixed ungraded practice quiz only.
//
//   docker exec -w /app canvas-grove-sync-worker-1 npx tsx scripts/quiz-oqaat-live.ts
//
// Steps: live preflight -> start (or resume) -> answer the first 3 questions with their first
// choice -> Canvas-side Next/Next/Previous -> flag one question -> reload the whole attempt ->
// submit -> read-only API check that Canvas reports the attempt complete.
// Prints only step names, statuses and question/attempt ids (never tokens, cookies or text).
import * as nodeModule from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { assertDevOwner, devOwnerId } from "../lib/dev/dev-owner";

// The service is a Next server module. Outside Next, its "server-only" guard resolves to the package's
// empty build, and next/server's request-scope `connection()` (awaited by ensureUserForClerk) is a no-op.
const serverOnlyEmpty = pathToFileURL(path.join(process.cwd(), "node_modules/server-only/empty.js")).href;
const NEXT_SERVER_STUB = "grove-dev-stub:next-server";
type HookContext = { parentURL?: string };
type ResolveHook = (specifier: string, context: HookContext, next: (specifier: string, context: HookContext) => unknown) => unknown;
type LoadHook = (url: string, context: unknown, next: (url: string, context: unknown) => unknown) => unknown;
(nodeModule as unknown as { registerHooks(hooks: { resolve: ResolveHook; load: LoadHook }): void }).registerHooks({
  resolve: (specifier, context, next) => {
    if (specifier === "server-only") return { url: serverOnlyEmpty, format: "commonjs", shortCircuit: true };
    if (specifier === "next/server" && /\/lib\/db\/auth-context\.ts$/.test(context.parentURL ?? "")) return { url: NEXT_SERVER_STUB, format: "commonjs", shortCircuit: true };
    return next(specifier, context);
  },
  load: (url, context, next) => url === NEXT_SERVER_STUB ? { format: "commonjs", source: "exports.connection = async () => undefined;", shortCircuit: true } : next(url, context),
});

// The only quiz this script may ever touch: UF "Spring 2023 Practice Exam 3" (ungraded practice, unlimited attempts).
const CANVAS_COURSE_ID = "565820";
const CANVAS_QUIZ_ID = "1632434";

const log = (step: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ step, ...fields }));

async function main() {
  const ownerId = devOwnerId();
  assertDevOwner(ownerId, "the live one-question-at-a-time quiz run");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tenant = <T>(work: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${ownerId}, true)`; return work(tx); }) as Promise<T>;
  const [target] = await tenant((tx) => tx<{ id: string; canvas_quiz_id: string; canvas_course_id: string; clerk_user_id: string }[]>`
    select q.id, q.canvas_quiz_id, c.canvas_course_id, u.clerk_user_id from quizzes q join courses c on c.id = q.course_id and c.owner_id = q.owner_id join users u on u.id = q.owner_id
    where q.owner_id = ${ownerId} and q.canvas_quiz_id = ${CANVAS_QUIZ_ID} and c.canvas_course_id = ${CANVAS_COURSE_ID} and q.deleted_at is null`);
  await sql.end();
  if (!target || target.canvas_quiz_id !== CANVAS_QUIZ_ID || target.canvas_course_id !== CANVAS_COURSE_ID) throw new Error("The allowed practice quiz is not synced for the developer account.");
  const ctx = { ownerId, clerkUserId: target.clerk_user_id } as const;
  const quizId = target.id;

  const service = await import("../lib/quizzes/service");
  const { executeCanvasApiForSession, hostedSessionStore } = await import("../lib/bridge/hosted-browser");

  const preflight = await service.getQuizPreflight(ctx, quizId, { live: true });
  log("preflight", { canvasQuiz: CANVAS_QUIZ_ID, status: preflight.availability.status, canStart: preflight.availability.canStart, reason: preflight.availability.reason ?? null, formatVerification: preflight.formatVerification, activeAttempt: preflight.activeAttempt?.id ?? null });
  if (preflight.availability.status === "unsupported") throw new Error("Quiz is still blocked; refusing to start.");

  const bundle = await service.startAttempt(ctx, quizId, true);
  log(preflight.availability.status === "in_progress" ? "resume" : "start", { attemptId: bundle.attempt.id, attempt: bundle.attempt.attempt, state: bundle.attempt.state, nativeSupported: bundle.nativeSupported, block: bundle.nativeBlock?.code ?? null, questions: bundle.questions.length, secondsRemaining: bundle.timing.secondsRemaining });
  if (!bundle.nativeSupported) throw new Error(`Native mode refused this attempt (${bundle.nativeBlock?.code}); it stays active in Canvas.`);

  const first = bundle.questions.slice(0, 3);
  log("read", { questions: first.map((question) => ({ id: question.id, position: question.position, type: question.type, options: question.options.length })) });
  let revision = 0;
  const chosen = new Map<string, number>();
  for (const [index, question] of first.entries()) {
    if (!["multiple_choice", "true_false"].includes(question.type) || !question.options.length) { log("answer_skipped", { questionId: question.id, type: question.type }); continue; }
    const choice = question.options[0].id;
    const saved = await service.saveAnswer(ctx, quizId, question.id, choice, undefined, revision);
    revision = saved.revision;
    chosen.set(question.id, choice);
    log("answer", { questionId: question.id, answerId: choice, saved: saved.saved, echoed: saved.question.answer === choice, secondsRemaining: saved.timing.secondsRemaining });
    if (index < first.length - 1) {
      const moved = await service.navigateAttempt(ctx, quizId, question.id, "next");
      log("next", { from: question.id, to: moved.questionId, expected: first[index + 1].id });
    }
  }
  const last = first[first.length - 1];
  const back = await service.navigateAttempt(ctx, quizId, last.id, "previous");
  log("previous", { from: last.id, to: back.questionId, expected: first[first.length - 2]?.id, storedAnswerShown: back.question.answer === chosen.get(back.questionId) });

  const flagged = await service.saveAnswer(ctx, quizId, last.id, undefined, true, revision);
  revision = flagged.revision;
  log("flag", { questionId: last.id, saved: flagged.saved });

  const reloaded = await service.getCurrentAttempt(ctx, quizId);
  const answeredIds = reloaded.questions.filter((question) => question.answer != null).map((question) => question.id);
  log("reload", {
    attemptId: reloaded.attempt.id, nativeSupported: reloaded.nativeSupported, questions: reloaded.questions.length, answered: answeredIds,
    answersMatch: [...chosen].every(([id, choice]) => reloaded.questions.find((question) => question.id === id)?.answer === choice),
    flagRoundTrip: reloaded.questions.find((question) => question.id === last.id)?.flagged === true,
  });

  const receipt = await service.submitAttempt(ctx, quizId, true, reloaded.attempt.attempt, 0);
  log("submit", { submitted: receipt.submitted, replay: receipt.replay, attemptId: receipt.receipt.id, attempt: receipt.receipt.attempt, state: receipt.receipt.state, finishedAt: receipt.receipt.finishedAt, warnings: "warnings" in receipt ? receipt.warnings : [] });

  // Independent read-only confirmation straight from the Canvas API.
  const session = (await hostedSessionStore.listForOwner(ctx.clerkUserId)).find((item) => item.state === "active");
  if (!session) throw new Error("No active Canvas session for the verification read.");
  const check = await executeCanvasApiForSession(session, ctx.clerkUserId, { method: "GET", path: `/api/v1/courses/${CANVAS_COURSE_ID}/quizzes/${CANVAS_QUIZ_ID}/submission` });
  const rows = check.data && typeof check.data === "object" && Array.isArray((check.data as { quiz_submissions?: unknown }).quiz_submissions) ? (check.data as { quiz_submissions: Record<string, unknown>[] }).quiz_submissions : [];
  log("verify", { http: check.status, submissions: rows.map((row) => ({ id: row.id, attempt: row.attempt, workflow_state: row.workflow_state, finished: Boolean(row.finished_at) })) });
}

main().then(() => process.exit(0)).catch((error) => {
  log("failed", { code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null, message: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
  process.exit(1);
});
