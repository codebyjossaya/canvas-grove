import "server-only";
import type { AuthContext } from "@/lib/db/auth-context";
import { withTenantTransaction } from "@/lib/db";
import { canvasAccounts, quizAttempts, quizzes, syncCursors, syncJobs, syncPolicies } from "@/lib/db/schema";
import { tenantRepository } from "@/lib/db/repository";
import { and, desc, eq, inArray } from "drizzle-orm";
import { executeCanvasApiForSession, hostedSessionStore } from "@/lib/bridge/hosted-browser";
import { runSingleFlight } from "@/lib/bridge/single-flight";
import type { CanvasRequest } from "@/lib/bridge/types";
import { answerRequest, deriveQuizStatus, flagRequest, isRecord, normalizeAnswer, questionHasUnsupportedMedia, quizFailure, restrictionReason, safeQuizHtml, sanitizeQuestion, startRequest, submitRequest, timeRequest, validateOptionAnswer, SUPPORTED_CLASSIC_QUESTION_TYPES, type QuizStatus } from "./contracts";

type CanvasResult = { ok: boolean; status: number; authRequired: boolean; data?: unknown };
type QuizRow = NonNullable<Awaited<ReturnType<ReturnType<typeof tenantRepository>["getQuiz"]>>>;

export class QuizServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const serviceGlobals = globalThis as typeof globalThis & { __quizMutationFlights?: Map<string, Promise<unknown>> };
const mutationFlights = serviceGlobals.__quizMutationFlights ??= new Map<string, Promise<unknown>>();

async function activeSession(ctx: AuthContext) {
  const sessions = await hostedSessionStore.listForOwner(ctx.clerkUserId);
  const session = sessions.find((item) => item.state === "active");
  if (!session) throw new QuizServiceError("CANVAS_AUTH_EXPIRED", "Reconnect Canvas before using Quiz Mode.", 401);
  return session;
}

async function callCanvas(ctx: AuthContext, request: CanvasRequest): Promise<CanvasResult> {
  const session = await activeSession(ctx);
  // Direct server-side API call; it marks the session expired on auth rejection.
  const result = await executeCanvasApiForSession(session, ctx.clerkUserId, request);
  if (!result.ok) {
    const failure = quizFailure(result.status, result.authRequired);
    throw new QuizServiceError(failure.code, failure.error, failure.status);
  }
  return result;
}

function canvasId(value: string) {
  if (!/^\d+$/.test(value)) throw new QuizServiceError("INVALID_CANVAS_ID", "Canvas returned an invalid quiz identifier.");
  return value;
}

function asDate(value: unknown) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : null; }
function asNumber(value: unknown) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function firstSubmission(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const rows = Array.isArray(value.quiz_submissions) ? value.quiz_submissions : [];
  return rows.filter(isRecord).sort((left, right) => {
    const activeDifference = Number(isActiveSubmission(right)) - Number(isActiveSubmission(left));
    return activeDifference || (asNumber(right.attempt) ?? 0) - (asNumber(left.attempt) ?? 0);
  })[0] ?? null;
}

async function fetchQuestionPages(ctx: AuthContext, path: string, wrapped: boolean, expectedCount: number | null) {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await callCanvas(ctx, { method: "GET", path: `${path}${separator}per_page=100&page=${page}` });
    const raw = wrapped && isRecord(result.data) ? result.data.quiz_submission_questions : result.data;
    if (!Array.isArray(raw)) throw new QuizServiceError("QUIZ_QUESTIONS_INVALID", "Canvas returned an invalid question list. Open this quiz in Canvas.", 502);
    const pageRows = raw.filter(isRecord);
    for (const row of pageRows) {
      const id = String(row.id ?? "");
      if (id && !seen.has(id)) { seen.add(id); records.push(row); }
    }
    if (pageRows.length < 100 || expectedCount !== null && records.length >= expectedCount) break;
    if (page === 10) throw new QuizServiceError("QUIZ_TOO_LARGE", "This quiz has more than 1,000 questions and must be completed directly in Canvas.", 409);
  }
  if (expectedCount !== null && records.length < expectedCount) throw new QuizServiceError("QUIZ_QUESTIONS_INCOMPLETE", `Canvas reported ${expectedCount} questions but returned only ${records.length}. Quiz Mode will not show or submit an incomplete attempt.`, 409);
  return records;
}

async function persistQuiz(ctx: AuthContext, course: { id: string; canvasAccountId: string; canvasCourseId: string }, raw: Record<string, unknown>, engine = "classic") {
  const externalId = String(raw.id ?? raw.quiz_id ?? raw.assignment_id ?? "");
  if (!externalId) return;
  const reason = restrictionReason(raw, engine);
  const sourcePayload = {
    oneQuestionAtATime: Boolean(raw.one_question_at_a_time), cantGoBack: Boolean(raw.cant_go_back), requireLockdownBrowser: Boolean(raw.require_lockdown_browser), requireLockdownMonitor: Boolean(raw.require_lockdown_browser_monitor),
    accessCodeRequired: Boolean(raw.access_code), ipRestricted: Boolean(raw.ip_filter),
    hideResults: raw.hide_results ?? null, oneTimeResults: Boolean(raw.one_time_results),
  };
  await withTenantTransaction(ctx.ownerId, (tx) => tx.insert(quizzes).values({
    ownerId: ctx.ownerId, canvasAccountId: course.canvasAccountId, courseId: course.id, canvasQuizId: externalId,
    canvasAssignmentId: raw.assignment_id == null ? null : String(raw.assignment_id), engine, title: String(raw.title ?? raw.name ?? "Untitled quiz"),
    descriptionHtml: safeQuizHtml(raw.description), quizType: raw.quiz_type == null ? null : String(raw.quiz_type),
    pointsPossible: raw.points_possible == null ? null : String(raw.points_possible), questionCount: asNumber(raw.question_count),
    timeLimitMinutes: asNumber(raw.time_limit), allowedAttempts: asNumber(raw.allowed_attempts),
    scoringPolicy: raw.scoring_policy == null ? null : String(raw.scoring_policy), dueAt: asDate(raw.due_at), unlockAt: asDate(raw.unlock_at), lockAt: asDate(raw.lock_at),
    published: Boolean(raw.published ?? true), lockedForUser: Boolean(raw.locked_for_user), lockExplanation: raw.lock_explanation == null ? null : String(raw.lock_explanation),
    htmlUrl: raw.html_url == null ? null : String(raw.html_url), supported: !reason, unsupportedReason: reason, sourcePayload, syncedAt: new Date(), deletedAt: null, updatedAt: new Date(),
  }).onConflictDoUpdate({ target: [quizzes.courseId, quizzes.canvasQuizId], set: {
    engine, title: String(raw.title ?? raw.name ?? "Untitled quiz"), descriptionHtml: safeQuizHtml(raw.description),
    canvasAssignmentId: raw.assignment_id == null ? null : String(raw.assignment_id), quizType: raw.quiz_type == null ? null : String(raw.quiz_type),
    pointsPossible: raw.points_possible == null ? null : String(raw.points_possible), questionCount: asNumber(raw.question_count), timeLimitMinutes: asNumber(raw.time_limit),
    allowedAttempts: asNumber(raw.allowed_attempts), scoringPolicy: raw.scoring_policy == null ? null : String(raw.scoring_policy),
    dueAt: asDate(raw.due_at), unlockAt: asDate(raw.unlock_at), lockAt: asDate(raw.lock_at), published: Boolean(raw.published ?? true),
    lockedForUser: Boolean(raw.locked_for_user), lockExplanation: raw.lock_explanation == null ? null : String(raw.lock_explanation), htmlUrl: raw.html_url == null ? null : String(raw.html_url),
    supported: !reason, unsupportedReason: reason, sourcePayload, syncedAt: new Date(), deletedAt: null, updatedAt: new Date(),
  } }));
}

export async function refreshQuizCatalog(ctx: AuthContext) {
  const repo = tenantRepository(ctx);
  const courseRows = await repo.listCourses();
  for (const course of courseRows) {
    try {
      const result = await callCanvas(ctx, { method: "GET", path: `/api/v1/courses/${canvasId(course.canvasCourseId)}/quizzes?per_page=100` });
      if (Array.isArray(result.data)) for (const raw of result.data) if (isRecord(raw)) await persistQuiz(ctx, course, raw);
    } catch (error) {
      if (error instanceof QuizServiceError && ["CANVAS_AUTH_EXPIRED", "RATE_LIMITED"].includes(error.code)) throw error;
      // A single restricted course must not hide healthy quiz catalogs.
    }
    const courseAssignments = await repo.listAssignmentsForCourse(course.id);
    for (const assignment of courseAssignments) {
      const source = isRecord(assignment.sourcePayload) ? assignment.sourcePayload : {};
      if (assignment.submissionTypes.includes("external_tool") && (source.is_quiz_assignment === true || source.quiz_lti || /quiz/i.test(String(source.external_tool_tag_attributes ?? assignment.name)))) {
        await persistQuiz(ctx, course, { id: `assignment-${assignment.canvasAssignmentId}`, assignment_id: assignment.canvasAssignmentId, title: assignment.name, due_at: assignment.dueAt?.toISOString(), unlock_at: assignment.unlockAt?.toISOString(), lock_at: assignment.lockAt?.toISOString(), points_possible: assignment.pointsPossible, published: assignment.workflowState === "published", submission_types: assignment.submissionTypes, is_quiz_assignment: true, quiz_id: source.quiz_id }, "new_quiz");
      }
    }
  }
  return repo.listQuizzes();
}

async function submissionState(ctx: AuthContext, row: QuizRow) {
  const result = await callCanvas(ctx, { method: "GET", path: `/api/v1/courses/${canvasId(row.canvasCourseId)}/quizzes/${canvasId(row.quiz.canvasQuizId)}/submission?include[]=quiz` });
  return firstSubmission(result.data);
}

function isActiveSubmission(value: Record<string, unknown> | null) { return Boolean(value?.id && value.started_at && !value.finished_at && !["complete", "pending_review"].includes(String(value.workflow_state))); }
function isCompletedSubmission(value: Record<string, unknown> | null) {
  return Boolean(value?.finished_at || value?.submitted_at || ["complete", "pending_review", "submitted", "graded"].includes(String(value?.workflow_state)));
}
function statusFor(row: QuizRow, submission: Record<string, unknown> | null) {
  return deriveQuizStatus({
    supported: row.quiz.supported, unsupportedReason: row.quiz.unsupportedReason,
    published: row.quiz.published, lockedForUser: row.quiz.lockedForUser, lockExplanation: row.quiz.lockExplanation,
    unlockAt: row.quiz.unlockAt?.getTime() ?? null, dueAt: row.quiz.dueAt?.getTime() ?? null, lockAt: row.quiz.lockAt?.getTime() ?? null,
    active: isActiveSubmission(submission), completed: isCompletedSubmission(submission), completedAt: typeof submission?.finished_at === "string" ? submission.finished_at : typeof submission?.submitted_at === "string" ? submission.submitted_at : null,
    attempt: asNumber(submission?.attempt) ?? 0, extraAttempts: asNumber(submission?.extra_attempts) ?? 0, allowedAttempts: row.quiz.allowedAttempts,
  });
}

function publicQuiz(row: QuizRow, availability: ReturnType<typeof statusFor>) {
  return {
    id: row.quiz.id, courseId: row.quiz.courseId, courseName: row.courseName, courseCode: row.courseCode,
    title: row.quiz.title, descriptionHtml: row.quiz.descriptionHtml, dueAt: row.quiz.dueAt?.toISOString() ?? null,
    unlockAt: row.quiz.unlockAt?.toISOString() ?? null, lockAt: row.quiz.lockAt?.toISOString() ?? null,
    pointsPossible: row.quiz.pointsPossible == null ? null : Number(row.quiz.pointsPossible), timeLimitMinutes: row.quiz.timeLimitMinutes,
    allowedAttempts: row.quiz.allowedAttempts, questionCount: row.quiz.questionCount, published: row.quiz.published,
    canvasUrl: row.quiz.htmlUrl,
    attemptsUsed: availability.attemptsUsed, attemptsRemaining: availability.attemptsRemaining,
    attemptsKnown: availability.attemptsKnown, attemptsUnlimited: availability.attemptsUnlimited,
    actionable: availability.actionable, canStart: availability.canStart,
    hasCompletedAttempt: availability.hasCompletedAttempt, retakeAllowed: availability.retakeAllowed, completedAt: availability.completedAt,
    status: availability.status, supportReason: availability.reason ?? null,
  };
}

export async function getQuizPreflight(ctx: AuthContext, quizId: string, options: { live?: boolean } = {}) {
  const repo = tenantRepository(ctx);
  const row = await repo.getQuiz(quizId);
  if (!row) throw new QuizServiceError("QUIZ_NOT_FOUND", "Quiz not found.", 404);
  const cached = (await repo.listQuizAttempts(quizId))[0];
  const cachedSubmission = cached ? {
    id: cached.canvasQuizSubmissionId, attempt: cached.attempt, workflow_state: cached.workflowState,
    started_at: cached.startedAt?.toISOString(), finished_at: cached.finishedAt?.toISOString(), end_at: cached.endAt?.toISOString(),
  } : null;
  if (row.quiz.engine !== "classic" || !row.quiz.supported) {
    const availability = statusFor(row, cachedSubmission);
    return { quiz: publicQuiz(row, availability), availability: { ...availability, canStart: false }, attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining }, activeAttempt: null, formatVerification: "verified" as const, startWarning: null };
  }
  // Page preflight is intentionally DB-only. The durable worker keeps this
  // snapshot warm; explicit Start performs the authoritative Canvas checks
  // immediately before it can consume an attempt.
  if (!options.live) {
    const availability = statusFor(row, cachedSubmission);
    return {
      quiz: publicQuiz(row, availability), availability,
      attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining },
      activeAttempt: isActiveSubmission(cachedSubmission) ? publicAttempt(cachedSubmission!) : null,
      formatVerification: "after_start" as const,
      startWarning: "Canvas availability and hidden question formats will be checked again before any attempt is consumed.",
    };
  }
  const live = await callCanvas(ctx, { method: "GET", path: `/api/v1/courses/${canvasId(row.canvasCourseId)}/quizzes/${canvasId(row.quiz.canvasQuizId)}` });
  if (isRecord(live.data)) await persistQuiz(ctx, { id: row.quiz.courseId, canvasAccountId: row.quiz.canvasAccountId, canvasCourseId: row.canvasCourseId }, live.data);
  const refreshed = await tenantRepository(ctx).getQuiz(quizId) ?? row;
  const submission = await submissionState(ctx, refreshed).catch((error) => {
    if (error instanceof QuizServiceError && error.status === 404) return null;
    throw error;
  });
  const availability = statusFor(refreshed, submission);
  let formatVerification: "verified" | "after_start" = "verified";
  let startWarning: string | null = null;
  if (isRecord(live.data) && (live.data.published === false || isRecord(live.data.permissions) && live.data.permissions.submit === false)) {
    const blocked = { ...availability, status: "unsupported" as const, reason: live.data.published === false ? "This quiz is not published in Canvas." : "Canvas has not granted permission to submit this quiz.", canStart: false };
    return { quiz: publicQuiz(refreshed, blocked), availability: blocked, attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining }, activeAttempt: null, formatVerification, startWarning };
  }
  if (isRecord(live.data) && Array.isArray(live.data.question_types)) {
    const advertisedUnsupported = live.data.question_types.find((type) => {
      if (typeof type !== "string") return true;
      const canvasType = type.endsWith("_question") ? type : `${type}_question`;
      return !SUPPORTED_CLASSIC_QUESTION_TYPES.has(canvasType);
    });
    if (advertisedUnsupported) {
      const blocked = { ...availability, status: "unsupported" as const, reason: `Canvas reports ${String(advertisedUnsupported).replaceAll("_", " ")} questions that native Quiz Mode cannot safely save. Open it in Canvas.`, canStart: false };
      return { quiz: publicQuiz(refreshed, blocked), availability: blocked, attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining }, activeAttempt: null, formatVerification, startWarning };
    }
  }
  if (!isActiveSubmission(submission) && availability.canStart) {
    try {
      // Exhaust the pre-attempt question bank. A randomized group can expose a
      // smaller question_count than the backing bank, and an unsupported or
      // media-only question on a later page could still be selected by Canvas.
      const questions = await fetchQuestionPages(ctx, `/api/v1/courses/${canvasId(refreshed.canvasCourseId)}/quizzes/${canvasId(refreshed.quiz.canvasQuizId)}/questions`, false, null);
      const unsupported = questions.find((question) => !SUPPORTED_CLASSIC_QUESTION_TYPES.has(String(question.question_type)));
      if (unsupported) {
        const blocked = { ...availability, status: "unsupported" as const, reason: `This quiz contains ${String(unsupported.question_type).replaceAll("_", " ")} questions that native Quiz Mode cannot safely save. Open it in Canvas.` };
        return { quiz: publicQuiz(refreshed, blocked), availability: { ...blocked, canStart: false }, attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining }, activeAttempt: null, formatVerification, startWarning };
      }
      const incomplete = questions.find(questionHasUnsupportedMedia);
      if (incomplete) {
        const blocked = { ...availability, status: "unsupported" as const, reason: "This quiz contains image, media, SVG, or math content that native Quiz Mode cannot reproduce faithfully. Open it in Canvas.", canStart: false };
        return { quiz: publicQuiz(refreshed, blocked), availability: blocked, attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining }, activeAttempt: null, formatVerification, startWarning };
      }
    } catch (error) {
      if (error instanceof QuizServiceError && error.code === "QUIZ_RESTRICTED") {
        formatVerification = "after_start";
        startWarning = "Canvas hides this quiz's question formats until an attempt starts. Starting consumes an attempt and may start its timer. Quiz Mode will check every question immediately; if native mode cannot reproduce one safely, your active attempt will be preserved and you will continue in Canvas.";
      } else {
        throw error;
      }
    }
  }
  return { quiz: publicQuiz(refreshed, availability), availability, attempts: { used: availability.attemptsUsed, remaining: availability.attemptsRemaining }, activeAttempt: submission && isActiveSubmission(submission) ? publicAttempt(submission) : null, formatVerification, startWarning };
}

function publicAttempt(value: Record<string, unknown>) {
  const state = String(value.workflow_state ?? "untaken");
  return { id: String(value.id), attempt: asNumber(value.attempt) ?? 0, state, workflowState: state, startedAt: value.started_at ?? null, finishedAt: value.finished_at ?? null, endAt: value.end_at ?? null, timeSpentSeconds: asNumber(value.time_spent), score: asNumber(value.score), keptScore: asNumber(value.kept_score), overdue: Boolean(value.overdue_and_needs_submission) };
}

async function persistAttempt(ctx: AuthContext, quizId: string, value: Record<string, unknown>) {
  const external = String(value.id ?? ""); if (!/^\d+$/.test(external)) return;
  await withTenantTransaction(ctx.ownerId, (tx) => tx.insert(quizAttempts).values({
    ownerId: ctx.ownerId, quizId, canvasQuizSubmissionId: external, attempt: asNumber(value.attempt) ?? 0,
    workflowState: String(value.workflow_state ?? "untaken"), startedAt: asDate(value.started_at), finishedAt: asDate(value.finished_at), endAt: asDate(value.end_at),
    score: value.score == null ? null : String(value.score), keptScore: value.kept_score == null ? null : String(value.kept_score), timeSpentSeconds: asNumber(value.time_spent), lastObservedAt: new Date(), updatedAt: new Date(),
  }).onConflictDoUpdate({ target: [quizAttempts.quizId, quizAttempts.canvasQuizSubmissionId], set: {
    attempt: asNumber(value.attempt) ?? 0, workflowState: String(value.workflow_state ?? "untaken"), startedAt: asDate(value.started_at), finishedAt: asDate(value.finished_at), endAt: asDate(value.end_at), score: value.score == null ? null : String(value.score), keptScore: value.kept_score == null ? null : String(value.kept_score), timeSpentSeconds: asNumber(value.time_spent), lastObservedAt: new Date(), updatedAt: new Date(),
  } }));
}

async function attemptBundle(ctx: AuthContext, row: QuizRow, submission: Record<string, unknown>) {
  await persistAttempt(ctx, row.quiz.id, submission);
  const submissionId = canvasId(String(submission.id));
  const [questionsOutcome, timeOutcome] = await Promise.allSettled([
    fetchQuestionPages(ctx, `/api/v1/quiz_submissions/${submissionId}/questions?include[]=quiz_question`, true, row.quiz.questionCount),
    callCanvas(ctx, timeRequest(row.canvasCourseId, row.quiz.canvasQuizId, submissionId)),
  ]);
  const timeResult = timeOutcome.status === "fulfilled" ? timeOutcome.value : { timerError: timeOutcome.reason instanceof Error ? timeOutcome.reason.message : "Canvas timer is unavailable." };
  const timing = timeResult && "data" in timeResult && isRecord(timeResult.data) ? { startedAt: submission.started_at ?? null, expiresAt: timeResult.data.end_at ?? submission.end_at ?? null, secondsRemaining: asNumber(timeResult.data.time_left), stale: false, error: null } : { startedAt: submission.started_at ?? null, expiresAt: submission.end_at ?? null, secondsRemaining: null, stale: true, error: timeResult && "timerError" in timeResult ? timeResult.timerError : "Canvas timer is unavailable." };
  const externalOnly = (code: string, message: string) => ({
    attempt: publicAttempt(submission), questions: [], timing, nativeSupported: false as const,
    nativeBlock: { code, message, canvasUrl: row.quiz.htmlUrl },
  });
  if (questionsOutcome.status === "rejected") {
    const error = questionsOutcome.reason;
    if (error instanceof QuizServiceError && ["QUIZ_QUESTIONS_INCOMPLETE", "QUIZ_TOO_LARGE", "QUIZ_QUESTIONS_INVALID", "QUIZ_RESTRICTED"].includes(error.code)) {
      return externalOnly(error.code, `${error.message} Your Canvas attempt is still active; continue it directly in Canvas.`);
    }
    throw error;
  }
  const rawQuestions = questionsOutcome.value;
  const incomplete = rawQuestions.filter(isRecord).find(questionHasUnsupportedMedia);
  if (incomplete) return externalOnly("UNSUPPORTED_QUESTION_MEDIA", "This attempt contains image, media, SVG, or math content that native Quiz Mode cannot reproduce faithfully. Your active attempt has been preserved; continue it directly in Canvas.");
  const questions = rawQuestions.filter(isRecord).map(sanitizeQuestion);
  const supportedUiTypes = new Set(["multiple_choice", "true_false", "multiple_answers", "short_answer", "essay", "numerical", "calculated"]);
  const unsupported = questions.find((question) => !supportedUiTypes.has(question.type));
  if (unsupported) return externalOnly("UNSUPPORTED_QUESTION_TYPE", `Question ${unsupported.position || ""} uses a Canvas type native Quiz Mode cannot safely save. Your active attempt has been preserved; continue it directly in Canvas.`);
  return { attempt: publicAttempt(submission), questions, timing, nativeSupported: true as const, nativeBlock: null };
}

export async function getCurrentAttempt(ctx: AuthContext, quizId: string) {
  const row = await tenantRepository(ctx).getQuiz(quizId); if (!row) throw new QuizServiceError("QUIZ_NOT_FOUND", "Quiz not found.", 404);
  const submission = await submissionState(ctx, row);
  if (!submission || !isActiveSubmission(submission)) throw new QuizServiceError("NO_ACTIVE_ATTEMPT", "There is no active Canvas attempt to resume.", 404);
  return attemptBundle(ctx, row, submission);
}

export async function getAttemptTime(ctx: AuthContext, quizId: string) {
  const row = await tenantRepository(ctx).getQuiz(quizId);
  if (!row) throw new QuizServiceError("QUIZ_NOT_FOUND", "Quiz not found.", 404);
  const submission = await submissionState(ctx, row);
  if (!submission || !isActiveSubmission(submission)) throw new QuizServiceError("NO_ACTIVE_ATTEMPT", "There is no active Canvas attempt to time.", 404);
  const result = await callCanvas(ctx, timeRequest(row.canvasCourseId, row.quiz.canvasQuizId, String(submission.id)));
  const time = isRecord(result.data) ? result.data : null;
  if (!time) throw new QuizServiceError("QUIZ_TIMER_UNAVAILABLE", "Canvas did not return an authoritative timer. Keep this page open and check Canvas before submitting.", 502);
  return {
    attempt: publicAttempt(submission),
    timing: {
      startedAt: submission.started_at ?? null,
      expiresAt: time.end_at ?? submission.end_at ?? null,
      secondsRemaining: asNumber(time.time_left),
      stale: false,
      error: null,
    },
  };
}

export async function startAttempt(ctx: AuthContext, quizId: string, confirmed: boolean) {
  return runSingleFlight(mutationFlights, `start:${ctx.ownerId}:${quizId}`, () => startAttemptOnce(ctx, quizId, confirmed)) as Promise<Awaited<ReturnType<typeof startAttemptOnce>>>;
}
async function startAttemptOnce(ctx: AuthContext, quizId: string, confirmed: boolean) {
  if (!confirmed) throw new QuizServiceError("START_CONFIRMATION_REQUIRED", "Confirm that you want Canvas to consume an attempt before starting.", 409);
  const preflight = await getQuizPreflight(ctx, quizId, { live: true });
  if (preflight.availability.status === "in_progress") return getCurrentAttempt(ctx, quizId);
  if (!preflight.availability.canStart) throw new QuizServiceError("QUIZ_NOT_STARTABLE", preflight.availability.reason ?? "This quiz cannot be started.", 409);
  const row = await tenantRepository(ctx).getQuiz(quizId); if (!row) throw new QuizServiceError("QUIZ_NOT_FOUND", "Quiz not found.", 404);
  let submission: Record<string, unknown> | null = null;
  try { submission = firstSubmission((await callCanvas(ctx, startRequest(row.canvasCourseId, row.quiz.canvasQuizId))).data); }
  catch (error) {
    // A transport failure can happen after Canvas consumed the attempt. Always
    // reread before reporting failure so the UI never offers another start
    // while an unseen timer may already be running.
    try {
      const reread = await submissionState(ctx, row);
      if (isActiveSubmission(reread)) submission = reread;
      else throw error;
    } catch (rereadError) {
      if (rereadError === error) throw error;
      throw new QuizServiceError("ATTEMPT_START_STATE_UNKNOWN", "Canvas may have started this attempt, but Quiz Mode could not confirm its state. Do not start another attempt; retry Resume or check Canvas.", 409);
    }
  }
  if (!submission) throw new QuizServiceError("QUIZ_START_FAILED", "Canvas did not create or return a quiz attempt.", 502);
  try {
    const bundle = await attemptBundle(ctx, row, submission);
    void enqueueQuizRefresh(ctx, row.quiz.canvasAccountId, "quiz_started", row.quiz.id).catch(() => undefined);
    return bundle;
  }
  catch (error) {
    const reread = await submissionState(ctx, row).catch(() => submission);
    if (isActiveSubmission(reread)) throw new QuizServiceError("ATTEMPT_STARTED_LOAD_FAILED", "Canvas started this attempt and its timer may be running, but Quiz Mode could not load it safely. Do not start another attempt; retry Resume or continue in Canvas.", 409);
    throw error;
  }
}

async function currentWithToken(ctx: AuthContext, row: QuizRow) {
  const submission = await submissionState(ctx, row);
  if (!submission || !isActiveSubmission(submission)) throw new QuizServiceError("NO_ACTIVE_ATTEMPT", "This Canvas attempt is no longer active.", 409);
  const token = typeof submission.validation_token === "string" ? submission.validation_token : "";
  if (!token) throw new QuizServiceError("QUIZ_SESSION_UNAVAILABLE", "Canvas did not return the secure token needed to save this attempt. Continue in Canvas.", 409);
  return { submission, token };
}

export async function saveAnswer(ctx: AuthContext, quizId: string, questionId: string, answer: unknown, flagged: boolean | undefined, revision: number) {
  return runSingleFlight(mutationFlights, `save:${ctx.ownerId}:${quizId}:${questionId}:${revision}`, () => saveAnswerOnce(ctx, quizId, questionId, answer, flagged, revision)) as Promise<Awaited<ReturnType<typeof saveAnswerOnce>>>;
}
async function saveAnswerOnce(ctx: AuthContext, quizId: string, questionId: string, answer: unknown, flagged: boolean | undefined, revision: number) {
  const row = await tenantRepository(ctx).getQuiz(quizId); if (!row) throw new QuizServiceError("QUIZ_NOT_FOUND", "Quiz not found.", 404);
  const { submission, token } = await currentWithToken(ctx, row);
  const bundle = await attemptBundle(ctx, row, submission);
  const question = bundle.questions.find((item) => item.id === questionId);
  if (!question) throw new QuizServiceError("QUESTION_NOT_FOUND", "This question is not part of the active attempt.", 404);
  const normalized = answer === undefined ? question.answer : normalizeAnswer(question.type, answer);
  if (answer !== undefined) validateOptionAnswer(question, normalized);
  let returned: Record<string, unknown> | null = null;
  if (answer !== undefined) {
    const saved = await callCanvas(ctx, answerRequest(String(submission.id), Number(submission.attempt), token, questionId, normalized));
    returned = Array.isArray(saved.data) ? saved.data.find(isRecord) ?? null : null;
  }
  if (typeof flagged === "boolean" && flagged !== question.flagged) await callCanvas(ctx, flagRequest(String(submission.id), questionId, flagged, Number(submission.attempt), token));
  const timingResult = await callCanvas(ctx, timeRequest(row.canvasCourseId, row.quiz.canvasQuizId, String(submission.id))).catch((error) => ({ data: null, timerError: error instanceof Error ? error.message : "Canvas timer is unavailable." }));
  const timeData = isRecord(timingResult.data) ? timingResult.data : null;
  return { saved: true, revision: revision + 1, question: returned ? sanitizeQuestion(returned) : { ...question, answer: normalized, flagged: flagged ?? question.flagged }, savedAt: new Date().toISOString(), timing: { startedAt: submission.started_at ?? null, expiresAt: timeData?.end_at ?? submission.end_at ?? null, secondsRemaining: asNumber(timeData?.time_left), stale: !timeData, error: timeData ? null : "Canvas timer is unavailable." } };
}

export async function submitAttempt(ctx: AuthContext, quizId: string, confirmSubmit: boolean, expectedAttempt: number, pendingSaves: number) {
  return runSingleFlight(mutationFlights, `submit:${ctx.ownerId}:${quizId}:${expectedAttempt}`, () => submitAttemptOnce(ctx, quizId, confirmSubmit, expectedAttempt, pendingSaves)) as Promise<Awaited<ReturnType<typeof submitAttemptOnce>>>;
}
async function submitAttemptOnce(ctx: AuthContext, quizId: string, confirmSubmit: boolean, expectedAttempt: number, pendingSaves: number) {
  if (!confirmSubmit) throw new QuizServiceError("SUBMIT_CONFIRMATION_REQUIRED", "Final submission requires explicit confirmation.", 409);
  if (pendingSaves !== 0) throw new QuizServiceError("PENDING_SAVES", "Wait for every answer to finish saving before final submission.", 409);
  const row = await tenantRepository(ctx).getQuiz(quizId); if (!row) throw new QuizServiceError("QUIZ_NOT_FOUND", "Quiz not found.", 404);
  const existing = await submissionState(ctx, row);
  if (existing && (existing.finished_at || ["complete", "pending_review"].includes(String(existing.workflow_state)))) return { submitted: true, replay: true, receipt: publicAttempt(existing) };
  const { submission, token } = await currentWithToken(ctx, row);
  if (Number(submission.attempt) !== expectedAttempt) throw new QuizServiceError("ATTEMPT_CHANGED", "Canvas is now on a different attempt. Reload before submitting.", 409);
  const nativeBundle = await attemptBundle(ctx, row, submission);
  if (!nativeBundle.nativeSupported) throw new QuizServiceError("QUIZ_NATIVE_SUBMIT_BLOCKED", "This attempt contains content native Quiz Mode cannot reproduce safely. Continue and submit it directly in Canvas.", 409);
  let result: CanvasResult;
  try { result = await callCanvas(ctx, submitRequest(row.canvasCourseId, row.quiz.canvasQuizId, String(submission.id), expectedAttempt, token)); }
  catch (error) {
    const reread = await submissionState(ctx, row).catch(() => null);
    if (reread && (reread.finished_at || ["complete", "pending_review"].includes(String(reread.workflow_state)))) return { submitted: true, replay: true, receipt: publicAttempt(reread) };
    throw error;
  }
  // Canvas completion is the irreversible commit point. Local bookkeeping is
  // deliberately best-effort after this line so the UI can never claim that a
  // confirmed Canvas submission was unconfirmed merely because our DB/sync
  // queue had a transient failure.
  const completed = { ...(firstSubmission(result.data) ?? submission), workflow_state: firstSubmission(result.data)?.workflow_state ?? "complete", finished_at: firstSubmission(result.data)?.finished_at ?? new Date().toISOString() };
  const warnings: string[] = [];
  try { await persistAttempt(ctx, quizId, completed); } catch (error) { console.error("quiz_attempt_receipt_persist_failed", { quizId, error: error instanceof Error ? error.message : "unknown" }); warnings.push("receipt_cache_pending"); }
  try { await enqueuePostSubmitSync(ctx, row); } catch (error) { console.error("quiz_submit_sync_enqueue_failed", { quizId, error: error instanceof Error ? error.message : "unknown" }); warnings.push("resync_pending"); }
  return { submitted: true, replay: false, receipt: publicAttempt(completed), warnings };
}

async function enqueuePostSubmitSync(ctx: AuthContext, row: QuizRow) {
  const session = await activeSession(ctx);
  for (const kind of ["assignments", "grades", "quizzes"] as const) {
    await withTenantTransaction(ctx.ownerId, (tx) => tx.insert(syncJobs).values({
      ownerId: ctx.ownerId, canvasAccountId: row.quiz.canvasAccountId, hostedSessionId: session.id, kind,
      scope: { reason: "quiz_submitted", quizId: row.quiz.id }, dedupeKey: `quiz-submit:${row.quiz.id}:${kind}`, priority: 200, runAfter: new Date(),
    }).onConflictDoNothing());
  }
}

async function enqueueQuizRefresh(ctx: AuthContext, canvasAccountId: string, reason: string, quizId?: string) {
  const session = await activeSession(ctx);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const policies = await tx.insert(syncPolicies).values({
      ownerId: ctx.ownerId, canvasAccountId, resourceType: "quizzes", scopeKey: "", intervalSeconds: 300,
      freshnessSeconds: 600, jitterSeconds: 30, priority: 85, nextRunAt: new Date(), status: "active",
    }).onConflictDoUpdate({ target: [syncPolicies.canvasAccountId, syncPolicies.resourceType, syncPolicies.scopeKey], set: { status: "active", updatedAt: new Date() } }).returning({ id: syncPolicies.id });
    const inserted = await tx.insert(syncJobs).values({
      ownerId: ctx.ownerId, canvasAccountId, policyId: policies[0]?.id, hostedSessionId: session.id, kind: "quizzes",
      scope: { reason, quizId }, dedupeKey: `${canvasAccountId}:quizzes`, priority: reason === "scheduled" ? 85 : 220, runAfter: new Date(),
    }).onConflictDoNothing().returning({ id: syncJobs.id });
    return inserted[0]?.id ?? null;
  });
}

async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await work(items[index]);
    }
  }));
  return output;
}

async function assignmentSubmissionIndex(ctx: AuthContext, rows: Awaited<ReturnType<ReturnType<typeof tenantRepository>["listQuizzes"]>>) {
  const courses = [...new Map(rows.map((row) => [row.canvasCourseId, row])).values()];
  const entries = await mapLimited(courses, 4, async (course) => {
    const assignments: Record<string, unknown>[] = [];
    try {
      for (let page = 1; page <= 10; page += 1) {
        const result = await callCanvas(ctx, { method: "GET", path: `/api/v1/courses/${canvasId(course.canvasCourseId)}/assignments?include[]=submission&per_page=100&page=${page}` });
        if (!Array.isArray(result.data)) break;
        const records = result.data.filter(isRecord);
        assignments.push(...records);
        if (records.length < 100) break;
      }
    } catch (error) {
      if (error instanceof QuizServiceError && ["CANVAS_AUTH_EXPIRED", "RATE_LIMITED"].includes(error.code)) throw error;
      return [] as Array<[string, Record<string, unknown>]>;
    }
    return assignments.flatMap((assignment): Array<[string, Record<string, unknown>]> => {
      const submission = isRecord(assignment.submission) ? assignment.submission : null;
      if (!submission || !isCompletedSubmission(submission)) return [];
      const assignmentId = String(assignment.id ?? "");
      if (!assignmentId) return [];
      // Canvas assignment submissions normally include an attempt number, but
      // older courses can omit it. A completed receipt still represents at
      // least one consumed attempt; treating it as zero would falsely offer a
      // retake on a single-attempt quiz.
      return [[`${course.canvasCourseId}:${assignmentId}`, {
        ...submission,
        attempt: asNumber(submission.attempt) ?? 1,
        finished_at: submission.finished_at ?? submission.submitted_at,
      }]];
    });
  });
  return new Map(entries.flat());
}

export async function listQuizSummaries(ctx: AuthContext, refresh = false) {
  const repo = tenantRepository(ctx);
  const listed = refresh ? await refreshQuizCatalog(ctx) : await repo.listQuizzes();
  // A New Quiz assignment and a quiz record can occasionally describe the same
  // Canvas assignment. Prefer the native Classic record and never show both.
  const deduped = [...listed.reduce((map, row) => {
    const key = row.canvasAssignmentId ? `${row.canvasCourseId}:assignment:${row.canvasAssignmentId}` : `${row.canvasCourseId}:quiz:${row.canvasQuizId}`;
    const prior = map.get(key);
    if (!prior || prior.engine !== "classic" && row.engine === "classic") map.set(key, row);
    return map;
  }, new Map<string, (typeof listed)[number]>()).values()];
  const assignments = refresh ? await assignmentSubmissionIndex(ctx, deduped) : new Map<string, Record<string, unknown>>();
  const cachedAttempts = new Map<string, Awaited<ReturnType<typeof repo.listQuizAttemptsForQuizzes>>[number]>();
  for (const attempt of await repo.listQuizAttemptsForQuizzes(deduped.map((row) => row.id))) if (!cachedAttempts.has(attempt.quizId)) cachedAttempts.set(attempt.quizId, attempt);
  const summaries = await mapLimited(deduped, 6, async (row) => {
    let submission = row.canvasAssignmentId ? assignments.get(`${row.canvasCourseId}:${row.canvasAssignmentId}`) ?? null : null;
    let statusStale = !refresh;
    if (refresh && row.engine === "classic" && row.supported && !submission) {
      try {
        const result = await callCanvas(ctx, { method: "GET", path: `/api/v1/courses/${canvasId(row.canvasCourseId)}/quizzes/${canvasId(row.canvasQuizId)}/submission?include[]=quiz` });
        submission = firstSubmission(result.data);
        statusStale = false;
        if (submission?.id) await persistAttempt(ctx, row.id, submission).catch(() => undefined);
      } catch (error) {
        if (error instanceof QuizServiceError && ["CANVAS_AUTH_EXPIRED", "RATE_LIMITED"].includes(error.code)) throw error;
        const cached = cachedAttempts.get(row.id);
        submission = cached ? { id: cached.canvasQuizSubmissionId, attempt: cached.attempt, workflow_state: cached.workflowState, started_at: cached.startedAt?.toISOString(), finished_at: cached.finishedAt?.toISOString(), end_at: cached.endAt?.toISOString() } : null;
        statusStale = true;
      }
    } else if (!submission) {
      const cached = cachedAttempts.get(row.id);
      submission = cached ? { id: cached.canvasQuizSubmissionId, attempt: cached.attempt, workflow_state: cached.workflowState, started_at: cached.startedAt?.toISOString(), finished_at: cached.finishedAt?.toISOString(), end_at: cached.endAt?.toISOString() } : null;
    }
    const availability = deriveQuizStatus({
      supported: row.supported, unsupportedReason: row.unsupportedReason, published: row.published,
      lockedForUser: row.lockedForUser, lockExplanation: row.lockExplanation,
      unlockAt: row.unlockAt?.getTime() ?? null, dueAt: row.dueAt?.getTime() ?? null, lockAt: row.lockAt?.getTime() ?? null,
      active: isActiveSubmission(submission), completed: isCompletedSubmission(submission),
      completedAt: typeof submission?.finished_at === "string" ? submission.finished_at : typeof submission?.submitted_at === "string" ? submission.submitted_at : null,
      attempt: asNumber(submission?.attempt) ?? 0, extraAttempts: asNumber(submission?.extra_attempts) ?? 0, allowedAttempts: row.allowedAttempts,
    });
    return {
      ...row, dueAt: row.dueAt?.toISOString() ?? null, unlockAt: row.unlockAt?.toISOString() ?? null, lockAt: row.lockAt?.toISOString() ?? null,
      pointsPossible: row.pointsPossible == null ? null : Number(row.pointsPossible), status: availability.status, supportReason: availability.reason ?? null,
      attemptsUsed: availability.attemptsUsed, attemptsRemaining: availability.attemptsRemaining, attemptsKnown: availability.attemptsKnown,
      attemptsUnlimited: availability.attemptsUnlimited, actionable: availability.actionable, canStart: availability.canStart,
      hasCompletedAttempt: availability.hasCompletedAttempt, retakeAllowed: availability.retakeAllowed, completedAt: availability.completedAt, statusStale,
    };
  });
  return summaries.sort((left, right) => {
    const rank = (status: QuizStatus) => status === "in_progress" ? 0 : status === "available" ? 1 : status === "upcoming" ? 2 : 3;
    return rank(left.status) - rank(right.status)
      || (left.dueAt == null ? 1 : right.dueAt == null ? -1 : left.dueAt.localeCompare(right.dueAt))
      || left.title.localeCompare(right.title);
  });
}

/**
 * Instant hub read. Canvas is never contacted on this request path: stale data
 * is returned immediately and a deduplicated durable worker job is queued.
 */
export async function getQuizHubData(ctx: AuthContext, forceRefresh = false) {
  const now = new Date();
  const accounts = await withTenantTransaction(ctx.ownerId, (tx) => tx.select({ id: canvasAccounts.id }).from(canvasAccounts)
    .where(and(eq(canvasAccounts.ownerId, ctx.ownerId), eq(canvasAccounts.status, "connected"))));
  const accountIds = accounts.map((item) => item.id);
  let cursors = accountIds.length ? await withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(syncCursors)
    .where(and(eq(syncCursors.ownerId, ctx.ownerId), inArray(syncCursors.canvasAccountId, accountIds), eq(syncCursors.resourceType, "quizzes")))
    .orderBy(desc(syncCursors.lastSuccessAt))) : [];
  const stale = accountIds.length > 0 && accountIds.some((id) => {
    const cursor = cursors.find((item) => item.canvasAccountId === id);
    return !cursor?.freshUntil || cursor.freshUntil <= now;
  });
  const jobIds: string[] = [];
  if (forceRefresh || stale) {
    for (const account of accounts) {
      const id = await enqueueQuizRefresh(ctx, account.id, forceRefresh ? "manual_refresh" : "scheduled").catch(() => null);
      if (id) jobIds.push(id);
    }
  }
  let activeJobs: Array<{ id: string }> = [];
  if (accountIds.length) {
    activeJobs = await withTenantTransaction(ctx.ownerId, (tx) => tx.select({ id: syncJobs.id }).from(syncJobs)
      .where(and(eq(syncJobs.ownerId, ctx.ownerId), eq(syncJobs.kind, "quizzes"), inArray(syncJobs.canvasAccountId, accountIds), inArray(syncJobs.status, ["queued", "leased", "running"]))));
  }
  // Reread so a concurrently completed worker can be reflected in this same
  // response without ever waiting on the Canvas network.
  if (activeJobs.length === 0 && jobIds.length === 0 && accountIds.length) cursors = await withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(syncCursors)
    .where(and(eq(syncCursors.ownerId, ctx.ownerId), inArray(syncCursors.canvasAccountId, accountIds), eq(syncCursors.resourceType, "quizzes"))).orderBy(desc(syncCursors.lastSuccessAt)));
  const lastSuccess = cursors.map((item) => item.lastSuccessAt?.getTime() ?? 0).filter(Boolean);
  const freshUntil = cursors.map((item) => item.freshUntil?.getTime() ?? 0).filter(Boolean);
  const failure = cursors.find((item) => item.lastErrorCode);
  return {
    quizzes: await listQuizSummaries(ctx, false),
    freshness: {
      lastSuccessAt: lastSuccess.length ? new Date(Math.max(...lastSuccess)).toISOString() : null,
      freshUntil: freshUntil.length ? new Date(Math.min(...freshUntil)).toISOString() : null,
      stale,
      refreshing: activeJobs.length > 0 || jobIds.length > 0,
      lastErrorCode: failure?.lastErrorCode ?? null,
    },
    refresh: { enqueued: jobIds.length > 0, jobId: jobIds[0] ?? activeJobs[0]?.id ?? null },
  };
}
