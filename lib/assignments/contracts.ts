import type { CanvasRequest } from "@/lib/bridge/types";

export const ASSIGNMENT_SUBMISSION_TYPES = ["online_text_entry", "online_url", "online_upload"] as const;
export type AssignmentSubmissionType = typeof ASSIGNMENT_SUBMISSION_TYPES[number];
export type AssignmentSubmissionInput =
  | { type: "online_text_entry"; body: string }
  | { type: "online_url"; url: string }
  | { type: "online_upload"; canvasFileIds: string[] };

export class AssignmentSubmissionInputError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function canvasId(value: string, label: string) {
  if (!/^\d{1,20}$/.test(value)) throw new AssignmentSubmissionInputError("INVALID_CANVAS_ID", `Canvas returned an invalid ${label}.`, 502);
  return value;
}

export function parseAssignmentSubmission(value: unknown): AssignmentSubmissionInput {
  if (!isRecord(value) || !ASSIGNMENT_SUBMISSION_TYPES.includes(value.type as AssignmentSubmissionType)) {
    throw new AssignmentSubmissionInputError("INVALID_SUBMISSION_TYPE", "Choose a supported assignment submission type.");
  }
  if (value.type === "online_text_entry") {
    if (typeof value.body !== "string" || !value.body.trim()) throw new AssignmentSubmissionInputError("SUBMISSION_BODY_REQUIRED", "Enter text to submit.");
    if (Buffer.byteLength(value.body, "utf8") > 50_000) throw new AssignmentSubmissionInputError("SUBMISSION_TOO_LARGE", "Text submissions must be 50 KB or less.", 413);
    return { type: value.type, body: value.body };
  }
  if (value.type === "online_url") {
    if (typeof value.url !== "string" || value.url.length > 2_000) throw new AssignmentSubmissionInputError("SUBMISSION_URL_REQUIRED", "Enter a valid website URL.");
    let url: URL;
    try { url = new URL(value.url); } catch { throw new AssignmentSubmissionInputError("SUBMISSION_URL_INVALID", "Enter a valid website URL."); }
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) throw new AssignmentSubmissionInputError("SUBMISSION_URL_INVALID", "Use an http or https URL without embedded credentials.");
    return { type: value.type, url: url.toString() };
  }
  if (!Array.isArray(value.canvasFileIds) || value.canvasFileIds.length < 1 || value.canvasFileIds.length > 10) {
    throw new AssignmentSubmissionInputError("SUBMISSION_FILES_REQUIRED", "Provide 1 to 10 Canvas file IDs already uploaded for this assignment.");
  }
  const ids = [...new Set(value.canvasFileIds.map((item) => typeof item === "string" ? item : ""))];
  if (ids.length !== value.canvasFileIds.length || ids.some((id) => !/^\d{1,20}$/.test(id))) {
    throw new AssignmentSubmissionInputError("SUBMISSION_FILES_INVALID", "Canvas file IDs must be unique numeric IDs.");
  }
  return { type: "online_upload", canvasFileIds: ids };
}

export function assignmentSubmissionRequest(courseId: string, assignmentId: string, input: AssignmentSubmissionInput): CanvasRequest {
  const submission: Record<string, unknown> = { submission_type: input.type };
  if (input.type === "online_text_entry") submission.body = input.body;
  else if (input.type === "online_url") submission.url = input.url;
  else submission.file_ids = input.canvasFileIds;
  return {
    method: "POST",
    path: `/api/v1/courses/${canvasId(courseId, "course id")}/assignments/${canvasId(assignmentId, "assignment id")}/submissions`,
    body: { submission },
  };
}

export function assignmentPreflightPath(courseId: string, assignmentId: string) {
  return `/api/v1/courses/${canvasId(courseId, "course id")}/assignments/${canvasId(assignmentId, "assignment id")}?include[]=submission&include[]=can_submit`;
}

const plainText = (value: unknown) => typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
const asStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Fail closed against Canvas's fresh assignment representation immediately before a write. */
export function assertLiveAssignmentAllows(value: unknown, type: AssignmentSubmissionType, now = Date.now()) {
  if (!isRecord(value)) throw new AssignmentSubmissionInputError("CANVAS_RESPONSE_INVALID", "Canvas returned an invalid assignment response. Nothing was submitted.", 502);
  if (value.published === false || value.workflow_state === "unpublished") throw new AssignmentSubmissionInputError("ASSIGNMENT_UNPUBLISHED", "This assignment is not published in Canvas.", 409);
  const unlockAt = typeof value.unlock_at === "string" ? Date.parse(value.unlock_at) : NaN;
  if (Number.isFinite(unlockAt) && unlockAt > now) throw new AssignmentSubmissionInputError("ASSIGNMENT_NOT_OPEN", "This assignment is not open yet.", 409);
  const lockAt = typeof value.lock_at === "string" ? Date.parse(value.lock_at) : NaN;
  if (value.locked_for_user === true || Number.isFinite(lockAt) && lockAt <= now) {
    throw new AssignmentSubmissionInputError("ASSIGNMENT_LOCKED", plainText(value.lock_explanation) || "This assignment is locked in Canvas.", 409);
  }
  const types = asStrings(value.submission_types);
  if (!types.includes(type)) throw new AssignmentSubmissionInputError("SUBMISSION_TYPE_NOT_ALLOWED", `This assignment accepts: ${types.join(", ") || "no online submissions"}.`, 409);
  if (value.can_submit === false) throw new AssignmentSubmissionInputError("SUBMISSION_NOT_ALLOWED", "Canvas is not allowing another submission for this assignment.", 409);
  const allowed = value.allowed_attempts == null || value.allowed_attempts === "" ? NaN : Number(value.allowed_attempts);
  const submission = isRecord(value.submission) ? value.submission : {};
  const attempt = submission.attempt == null || submission.attempt === "" ? NaN : Number(submission.attempt);
  const extra = submission.extra_attempts == null || submission.extra_attempts === "" ? 0 : Number(submission.extra_attempts);
  const totalAllowed = Number.isInteger(allowed) && allowed >= 0 ? allowed + (Number.isInteger(extra) && extra > 0 ? extra : 0) : allowed;
  const previouslySubmitted = Boolean(submission.submitted_at) || ["submitted", "pending_review", "graded"].includes(String(submission.workflow_state ?? ""));
  if (previouslySubmitted && Number.isInteger(totalAllowed) && totalAllowed >= 0 && Number.isInteger(attempt) && attempt >= totalAllowed) {
    throw new AssignmentSubmissionInputError("ATTEMPTS_EXHAUSTED", "No assignment submission attempts remain in Canvas.", 409);
  }
  return { submissionTypes: types, previousAttempt: Number.isInteger(attempt) ? attempt : 0, allowedAttempts: Number.isInteger(totalAllowed) ? totalAllowed : null };
}

export function idempotencyKeyFrom(request: Request) {
  const key = request.headers.get("x-idempotency-key") ?? request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) throw new AssignmentSubmissionInputError("INVALID_IDEMPOTENCY_KEY", "A valid idempotency key is required.");
  return key;
}

export function submissionFailure(status: number, authRequired = false) {
  if (authRequired) return { status: 401, code: "CANVAS_AUTH_EXPIRED", error: "Canvas sign-in has expired. Reconnect Canvas, then try again." };
  if (status === 400 || status === 422) return { status: 409, code: "SUBMISSION_REJECTED", error: "Canvas rejected this submission. Check the assignment rules and content before trying again." };
  if (status === 401 || status === 403) return { status: 403, code: "SUBMISSION_NOT_ALLOWED", error: "Canvas is not allowing this assignment submission. It may be locked, unpublished, or out of attempts." };
  if (status === 404) return { status: 404, code: "ASSIGNMENT_NOT_FOUND", error: "This assignment is no longer available in Canvas." };
  if (status === 409) return { status: 409, code: "SUBMISSION_CONFLICT", error: "Canvas reports that this assignment changed. Refresh it before trying again." };
  if (status === 429) return { status: 429, code: "RATE_LIMITED", error: "Canvas is rate limiting submissions. Wait a moment, then retry with the same submission." };
  return { status: 502, code: "CANVAS_SUBMISSION_FAILED", error: "Canvas could not complete this submission. Check Canvas before retrying." };
}
