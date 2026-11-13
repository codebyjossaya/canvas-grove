import { AUTO_CAPS, AUTO_DURATIONS, QUIZ_SESSION_MINUTES, isAutoCategory, type AutoCategory } from "./categories";

// Pure rules for phase 2: quiz eligibility (hard gate), auto-mode decisions and quiz-session
// binding. The DB layer calls these on every request; nothing here is cached.

type Stamp = Date | string | null | undefined;
const time = (value: Stamp) => (value ? new Date(value).getTime() : NaN);

// ------------------------------------------------------------------ quiz eligibility

export type QuizFacts = {
  engine: string | null; quiz_type: string | null; points_possible: unknown; supported: boolean | null;
  title: string | null; description_html: string | null; source_payload: unknown; deleted_at?: Stamp;
};
export type Eligibility = { eligible: true } | { eligible: false; code: "QUIZ_NOT_ELIGIBLE"; reason: string };
export type QuizAssessmentKind = "practice_quiz" | "graded_quiz" | "survey" | "graded_survey" | "unknown";
export type QuizClassification = { assessmentKind: QuizAssessmentKind; practice: boolean; graded: boolean | null; label: string };

const QUIZ_CLASSIFICATIONS: Record<string, QuizClassification> = {
  practice_quiz: { assessmentKind: "practice_quiz", practice: true, graded: false, label: "Practice quiz (ungraded)" },
  assignment: { assessmentKind: "graded_quiz", practice: false, graded: true, label: "Graded quiz" },
  survey: { assessmentKind: "survey", practice: false, graded: false, label: "Survey (ungraded)" },
  graded_survey: { assessmentKind: "graded_survey", practice: false, graded: true, label: "Graded survey" },
};

/** Canvas's four Classic Quiz modes, expressed without relying on points as a grading proxy. */
export function quizClassification(type: string | null | undefined): QuizClassification {
  return type && QUIZ_CLASSIFICATIONS[type]
    ? QUIZ_CLASSIFICATIONS[type]
    : { assessmentKind: "unknown", practice: false, graded: null, label: "Quiz (unknown type)" };
}

const RESTRICTION_FLAGS = ["requireLockdownBrowser", "requireLockdownMonitor", "accessCodeRequired", "ipRestricted"] as const;
const PROCTORING = /honorlock|respondus|lockdown browser|proctoru|proctorio|examity|proctored|proctor/i;
const no = (reason: string): Eligibility => ({ eligible: false, code: "QUIZ_NOT_ELIGIBLE", reason });

/**
 * All four Canvas Classic Quiz modes are eligible: practice quizzes, graded quizzes, ungraded
 * surveys and graded surveys. Technical restrictions still fail closed: proctoring/lockdown,
 * access codes, IP filters, New Quizzes, unsupported native content, and unknown restriction data.
 */
export function quizEligibility(quiz: QuizFacts | null | undefined): Eligibility {
  if (!quiz || quiz.deleted_at) return no("Quiz not found.");
  if (quiz.engine !== "classic") return no("New Quizzes (and other external quiz engines) are never available to assistants.");
  const flags = quiz.source_payload && typeof quiz.source_payload === "object" && !Array.isArray(quiz.source_payload) ? quiz.source_payload as Record<string, unknown> : null;
  if (!flags || RESTRICTION_FLAGS.some((key) => typeof flags[key] !== "boolean")) return no("Grove does not know this quiz's proctoring and access restrictions yet.");
  if (flags.requireLockdownBrowser || flags.requireLockdownMonitor) return no("This quiz requires a lockdown browser or monitoring.");
  if (flags.accessCodeRequired) return no("This quiz requires an access code.");
  if (flags.ipRestricted) return no("This quiz is restricted to an approved network.");
  if (PROCTORING.test(`${quiz.title ?? ""} ${quiz.description_html ?? ""}`)) return no("This quiz appears to be proctored.");
  if (quiz.supported !== true) return no("Grove's native quiz mode does not support this quiz.");
  const classification = quizClassification(quiz.quiz_type);
  if (classification.assessmentKind !== "unknown") return { eligible: true };
  return no("Grove cannot identify this as one of Canvas's supported Classic Quiz types.");
}

// ------------------------------------------------------------------ auto mode

export type AutoModeRow = { enabled: boolean; categories: string[]; expires_at: Stamp };
export type AutoDecision = { auto: true } | { auto: false; reason: "off" | "expired" | "category" | "hour_cap" | "day_cap" | "no_category" };

/** Whether a staged action in `category` may execute without approval right now. */
export function autoDecision(mode: AutoModeRow | null | undefined, category: AutoCategory | null, usedLastHour: number, usedToday: number, now = Date.now()): AutoDecision {
  if (!category) return { auto: false, reason: "no_category" };
  if (!mode || !mode.enabled) return { auto: false, reason: "off" };
  if (mode.expires_at != null && !(time(mode.expires_at) > now)) return { auto: false, reason: "expired" };
  if (!mode.categories.includes(category)) return { auto: false, reason: "category" };
  if (usedLastHour >= AUTO_CAPS.perHour) return { auto: false, reason: "hour_cap" };
  if (usedToday >= AUTO_CAPS.perDay) return { auto: false, reason: "day_cap" };
  return { auto: true };
}

/** Auto mode as the UI sees it: an expired setting reads as disabled. */
export const autoActive = (mode: AutoModeRow | null | undefined, now = Date.now()) =>
  !!mode && mode.enabled && (mode.expires_at == null || time(mode.expires_at) > now);

// ------------------------------------------------------------------ quiz sessions

export type QuizSessionRow = { quiz_id: string; canvas_submission_id: string; attempt: number; expires_at: Stamp; ended_at: Stamp };

/** Session usable for exactly this quiz and (when known) this Canvas attempt. */
export function sessionAllows(session: QuizSessionRow | null | undefined, quizId: string, live?: { submissionId: string; attempt: number } | null, now = Date.now()):
  { ok: true } | { ok: false; code: "NO_QUIZ_SESSION" | "QUIZ_SESSION_ENDED" | "QUIZ_SESSION_ATTEMPT_MISMATCH"; message: string } {
  if (!session || session.quiz_id !== quizId) return { ok: false, code: "NO_QUIZ_SESSION", message: "No approved quiz session for this quiz. Call start_quiz_attempt and wait for approval." };
  if (session.ended_at || !(time(session.expires_at) > now)) return { ok: false, code: "QUIZ_SESSION_ENDED", message: "This quiz session has ended. A new attempt needs a new approval." };
  if (live && (live.submissionId !== session.canvas_submission_id || live.attempt !== session.attempt))
    return { ok: false, code: "QUIZ_SESSION_ATTEMPT_MISMATCH", message: "Canvas is on a different attempt than the one that was approved. A new attempt needs a new approval." };
  return { ok: true };
}

/** Session end: the attempt's Canvas end time or 2 h, whichever is first. */
export function sessionExpiry(attemptEndAt: unknown, now = Date.now()): Date {
  const cap = now + QUIZ_SESSION_MINUTES * 60_000;
  const end = typeof attemptEndAt === "string" ? Date.parse(attemptEndAt) : NaN;
  return new Date(Number.isFinite(end) && end > now ? Math.min(end, cap) : cap);
}

// ------------------------------------------------------------------ auto-mode settings input (web API)

export type AutoInput = { enabled: boolean; categories: AutoCategory[]; durationMinutes: number | null };
export type AutoParse = { ok: true; value: AutoInput } | { ok: false; code: string; error: string };

export function parseAutoInput(body: unknown): AutoParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "BAD_REQUEST", error: "Invalid request." };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") return { ok: false, code: "BAD_REQUEST", error: "enabled must be true or false." };
  const raw = b.categories === undefined ? [] : b.categories;
  if (!Array.isArray(raw) || !raw.every(isAutoCategory)) return { ok: false, code: "BAD_CATEGORY", error: "Unknown auto-mode category." };
  const duration = b.durationMinutes === undefined ? 60 : b.durationMinutes;
  if (!(AUTO_DURATIONS as readonly (number | null)[]).includes(duration as number | null)) return { ok: false, code: "BAD_DURATION", error: "durationMinutes must be 60, 480, 1440 or null." };
  const categories = [...new Set(raw as AutoCategory[])];
  if (b.enabled && !categories.length) return { ok: false, code: "NO_CATEGORY", error: "Choose at least one category to turn on auto mode." };
  return { ok: true, value: { enabled: b.enabled, categories, durationMinutes: duration as number | null } };
}
