import type { CanvasRequest } from "@/lib/bridge/types";

export const SUPPORTED_CLASSIC_QUESTION_TYPES = new Set([
  "essay_question", "short_answer_question", "calculated_question", "numerical_question",
  "multiple_choice_question", "true_false_question", "multiple_answers_question",
]);

export type QuizStatus = "available" | "upcoming" | "locked" | "past_due" | "in_progress" | "completed" | "attempts_exhausted" | "unsupported";
export type QuizStatusInput = {
  supported: boolean; unsupportedReason?: string | null; published: boolean; lockedForUser: boolean; lockExplanation?: string | null;
  unlockAt?: number | null; dueAt?: number | null; lockAt?: number | null; now?: number;
  active: boolean; completed: boolean; completedAt?: string | null; attempt: number; extraAttempts: number; allowedAttempts: number | null;
};
export type DerivedQuizStatus = {
  status: QuizStatus; reason?: string; attemptsUsed: number; attemptsRemaining: number | null;
  attemptsKnown: boolean; attemptsUnlimited: boolean; actionable: boolean; canStart: boolean; hasCompletedAttempt: boolean; retakeAllowed: boolean; completedAt: string | null;
};

export function deriveQuizStatus(input: QuizStatusInput): DerivedQuizStatus {
  const now = input.now ?? Date.now();
  const attemptsKnown = input.allowedAttempts != null;
  const attemptsUnlimited = input.allowedAttempts === -1;
  const remaining = !attemptsKnown || attemptsUnlimited ? null : Math.max(0, input.allowedAttempts! + input.extraAttempts - input.attempt);
  const base = { attemptsUsed: input.attempt, attemptsRemaining: remaining, attemptsKnown, attemptsUnlimited, hasCompletedAttempt: input.completed, completedAt: input.completedAt ?? null };
  if (!input.supported) return { ...base, status: "unsupported", reason: input.unsupportedReason ?? "This quiz is not supported in native mode.", actionable: false, canStart: false, retakeAllowed: false };
  if (input.active) return { ...base, status: "in_progress", actionable: true, canStart: false, retakeAllowed: false };
  const unlocksLater = input.unlockAt != null && input.unlockAt > now;
  const hardLocked = !input.published || input.lockedForUser || input.lockAt != null && input.lockAt <= now;
  const attemptsRemain = !attemptsKnown || attemptsUnlimited || remaining! > 0;
  if (unlocksLater) return { ...base, status: "upcoming", reason: `Available ${new Date(input.unlockAt!).toISOString()}`, actionable: true, canStart: false, retakeAllowed: input.completed && attemptsRemain };
  if (input.completed) {
    if (!hardLocked && attemptsRemain) {
      if (input.dueAt != null && input.dueAt < now) return { ...base, status: "past_due", reason: "A previous attempt is complete. Canvas still permits another late attempt.", actionable: false, canStart: true, retakeAllowed: true };
      return { ...base, status: "available", reason: "A previous attempt is complete. Canvas permits another attempt.", actionable: true, canStart: true, retakeAllowed: true };
    }
    return { ...base, status: "completed", reason: remaining === 0 ? "Completed; no attempts remain." : "Completed; this quiz is no longer available.", actionable: false, canStart: false, retakeAllowed: false };
  }
  if (hardLocked) return { ...base, status: "locked", reason: input.lockExplanation ?? (!input.published ? "This quiz is not published." : "This quiz is locked in Canvas."), actionable: false, canStart: false, retakeAllowed: false };
  if (!attemptsRemain) return { ...base, status: "attempts_exhausted", reason: "No attempts remain in Canvas.", actionable: false, canStart: false, retakeAllowed: false };
  if (input.dueAt != null && input.dueAt < now) return { ...base, status: "past_due", reason: "The due date has passed, but Canvas still permits a late attempt.", actionable: false, canStart: true, retakeAllowed: false };
  return { ...base, status: "available", actionable: true, canStart: true, retakeAllowed: false };
}
export type QuizQuestion = {
  id: string; position: number; type: string; questionTextHtml: string; pointsPossible: number | null;
  flagged: boolean; answer: unknown; options: { id: number; textHtml: string; matchId?: number }[];
};

export function safeQuizHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.slice(0, 100_000)
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, " $1=\"#\"");
}
export function hasUnsupportedQuizMedia(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // Images and equations render natively (Canvas files/equation images stream through Grove's proxy;
  // MathML renders in the browser). Players and embeds cannot run here.
  return /<(video|audio|svg|canvas|iframe|object|embed)\b/i.test(value);
}
export function questionHasUnsupportedMedia(value: Record<string, unknown>): boolean {
  const source = isRecord(value.quiz_question) ? value.quiz_question : value;
  if (hasUnsupportedQuizMedia(source.question_text)) return true;
  const answers = Array.isArray(source.answers) ? source.answers : [];
  return answers.filter(isRecord).some((answer) => hasUnsupportedQuizMedia(answer.html) || hasUnsupportedQuizMedia(answer.text));
}

export function restrictionReason(value: Record<string, unknown>, engine = "classic"): string | null {
  if (engine !== "classic" || value.is_quiz_assignment === true && (value.quiz_id == null || value.submission_types === "external_tool") || Array.isArray(value.submission_types) && value.submission_types.includes("external_tool")) return "New Quizzes use an external assessment engine that this native mode cannot safely submit to. Open this quiz in Canvas.";
  const text = `${String(value.title ?? "")} ${String(value.description ?? "")}`.toLowerCase();
  if (value.require_lockdown_browser === true || value.require_lockdown_browser_monitor === true || /honorlock|respondus|lockdown browser|proctoru|proctored/.test(text)) return "This quiz requires proctoring or a lockdown browser. Take it directly in Canvas so those controls remain intact.";
  if (value.access_code) return "This quiz requires an access code. Native Quiz Mode does not handle access-code protected attempts.";
  if (value.ip_filter) return "This quiz is restricted to an approved network. Take it directly in Canvas on that network.";
  // one_question_at_a_time is supported: Canvas refuses the REST questions API for it (HTTP 401
  // "unauthorized"), so lib/quizzes/oqaat.ts drives Canvas's own quiz player routes instead.
  // cant_go_back stays blocked until its forward-only flow has been verified against Canvas.
  if (value.cant_go_back) return "This quiz prevents returning to earlier questions. Take it directly in Canvas so that rule is enforced exactly.";
  return null;
}

export function quizFailure(status: number, authRequired = false) {
  // A 401 without authRequired is Canvas's permission denial ("unauthorized"), not an expired sign-in.
  if (status === 401 && !authRequired) return { status: 403, code: "QUIZ_PERMISSION_DENIED", error: "Canvas does not allow this quiz action from outside its own quiz player. Your Canvas connection is fine; open this quiz in Canvas." };
  if (authRequired) return { status: 401, code: "CANVAS_AUTH_EXPIRED", error: "Canvas sign-in has expired. Reconnect Canvas, then return to the quiz." };
  if (status === 429) return { status: 429, code: "RATE_LIMITED", error: "Canvas is rate limiting quiz requests. Your last confirmed save remains in Canvas; wait a moment and retry." };
  if (status === 403) return { status: 403, code: "QUIZ_RESTRICTED", error: "Canvas is not allowing this quiz action. It may require an access code, approved network, or proctoring." };
  if (status === 404) return { status: 404, code: "QUIZ_NOT_FOUND", error: "This quiz is no longer available in Canvas." };
  if (status === 409) return { status: 409, code: "QUIZ_ATTEMPT_EXISTS", error: "Canvas already has an attempt for this quiz. Resume the existing attempt." };
  return { status: status >= 400 && status < 500 ? status : 502, code: "CANVAS_QUIZ_FAILED", error: "Canvas could not complete the quiz request. No automatic submission was attempted." };
}

export function startRequest(courseId: string, quizId: string): CanvasRequest {
  assertCanvasId(courseId); assertCanvasId(quizId);
  return { method: "POST", path: `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions` };
}
export function answerRequest(submissionId: string, attempt: number, validationToken: string, questionId: string, answer: unknown): CanvasRequest {
  assertCanvasId(submissionId); assertCanvasId(questionId);
  return { method: "POST", path: `/api/v1/quiz_submissions/${submissionId}/questions`, body: { attempt, validation_token: validationToken, quiz_questions: [{ id: questionId, answer }] } };
}
export function submitRequest(courseId: string, quizId: string, submissionId: string, attempt: number, validationToken: string): CanvasRequest {
  assertCanvasId(courseId); assertCanvasId(quizId); assertCanvasId(submissionId);
  return { method: "POST", path: `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}/complete`, body: { attempt, validation_token: validationToken } };
}
export function flagRequest(submissionId: string, questionId: string, flagged: boolean, attempt: number, validationToken: string): CanvasRequest {
  assertCanvasId(submissionId); assertCanvasId(questionId);
  return { method: "PUT", path: `/api/v1/quiz_submissions/${submissionId}/questions/${questionId}/${flagged ? "flag" : "unflag"}`, body: { attempt, validation_token: validationToken } };
}
export function timeRequest(courseId: string, quizId: string, submissionId: string): CanvasRequest {
  assertCanvasId(courseId); assertCanvasId(quizId); assertCanvasId(submissionId);
  return { method: "GET", path: `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}/time` };
}

export function normalizeAnswer(type: string, value: unknown): unknown {
  const canvasType = ({ multiple_choice: "multiple_choice_question", true_false: "true_false_question", multiple_answers: "multiple_answers_question", short_answer: "short_answer_question", essay: "essay_question", numerical: "numerical_question", calculated: "calculated_question" } as Record<string, string>)[type] ?? type;
  if (!SUPPORTED_CLASSIC_QUESTION_TYPES.has(canvasType)) throw new QuizInputError("UNSUPPORTED_QUESTION_TYPE", "This question type is not safely supported in native Quiz Mode. Continue in Canvas.");
  if (["essay_question", "short_answer_question"].includes(canvasType)) {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16_384) throw new QuizInputError("INVALID_ANSWER", "This text answer must be 16 KB or less.");
    return value;
  }
  if (["calculated_question", "numerical_question"].includes(canvasType)) {
    if ((typeof value !== "number" && typeof value !== "string") || value === "" || !Number.isFinite(Number(value))) throw new QuizInputError("INVALID_ANSWER", "Enter a valid number.");
    return value;
  }
  if (["multiple_choice_question", "true_false_question"].includes(canvasType)) {
    if (!Number.isInteger(value)) throw new QuizInputError("INVALID_ANSWER", "Choose one available answer.");
    return value;
  }
  if (canvasType === "multiple_answers_question") {
    if (!Array.isArray(value) || !value.every(Number.isInteger)) throw new QuizInputError("INVALID_ANSWER", "Choose only available answers.");
    return [...new Set(value as number[])];
  }
  throw new QuizInputError("UNSUPPORTED_QUESTION_TYPE", "This question type must be completed directly in Canvas.");
}

export function sanitizeQuestion(value: Record<string, unknown>): QuizQuestion {
  const source = isRecord(value.quiz_question) ? value.quiz_question : value;
  const rawAnswers = Array.isArray(source.answers) ? source.answers : Array.isArray(value.answers) ? value.answers : [];
  const rawType = String(source.question_type ?? "unknown");
  const type = ({ multiple_choice_question: "multiple_choice", true_false_question: "true_false", multiple_answers_question: "multiple_answers", short_answer_question: "short_answer", essay_question: "essay", numerical_question: "numerical", calculated_question: "calculated" } as Record<string, string>)[rawType] ?? rawType;
  return {
    id: String(value.id ?? source.id ?? ""), position: Number(source.position ?? 0), type,
    questionTextHtml: safeQuizHtml(source.question_text), pointsPossible: finiteOrNull(source.points_possible),
    flagged: Boolean(value.flagged), answer: value.answer ?? null,
    options: rawAnswers.filter(isRecord).map((answer) => ({ id: Number(answer.id), textHtml: safeQuizHtml(answer.html ?? answer.text), ...(Number.isInteger(answer.match_id) ? { matchId: Number(answer.match_id) } : {}) })).filter((answer) => Number.isInteger(answer.id)),
  };
}

export function validateOptionAnswer(question: QuizQuestion, value: unknown) {
  if (!["multiple_choice", "true_false", "multiple_answers"].includes(question.type)) return;
  const allowed = new Set(question.options.map((option) => option.id));
  const selected = Array.isArray(value) ? value : [value];
  if (!selected.length || selected.some((id) => !Number.isInteger(id) || !allowed.has(Number(id)))) throw new QuizInputError("INVALID_ANSWER_OPTION", "Choose only answers Canvas returned for this question.");
}

export class QuizInputError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
export function idempotencyKeyFrom(request: Request) {
  const key = request.headers.get("x-idempotency-key") ?? request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) throw new QuizInputError("INVALID_IDEMPOTENCY_KEY", "A valid idempotency key is required.");
  return key;
}
export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finiteOrNull = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
function assertCanvasId(value: string) { if (!/^\d+$/.test(value)) throw new QuizInputError("INVALID_CANVAS_ID", "Canvas returned an invalid quiz identifier."); }
