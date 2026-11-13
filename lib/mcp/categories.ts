// Shared by the Grove UI (approvals, auto-mode controls) and the MCP backend. Pure module: no
// server-only imports, safe in client components.

export const AUTO_CATEGORIES = ["submit_assignment", "outward_messages", "quiz_entry"] as const;
export type AutoCategory = (typeof AUTO_CATEGORIES)[number];

export const CATEGORY_INFO: Record<AutoCategory, { label: string; description: string }> = {
  submit_assignment: { label: "Submit assignments", description: "Turn in online text or URL submissions you asked the assistant to prepare." },
  outward_messages: { label: "Discussion replies and messages", description: "Post discussion replies and send Canvas messages." },
  quiz_entry: { label: "Start quizzes", description: "Start supported Classic Quiz attempts, including practice, graded, survey and graded-survey assessments." },
};

/** Auto-mode durations in minutes; null = until turned off. No category is preselected. */
export const AUTO_DURATIONS = [60, 480, 1440, null] as const;
export type AutoDuration = (typeof AUTO_DURATIONS)[number];
export const DEFAULT_AUTO_DURATION: AutoDuration = 60;
export const DEFAULT_AUTO_CATEGORIES: AutoCategory[] = [];
export const AUTO_CAPS = { perHour: 30, perDay: 200 } as const;

export const ACTION_STATUSES = ["awaiting_approval", "approved", "rejected", "executing", "done", "failed", "expired", "cancelled"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type DecidedBy = "you" | "auto" | "system";

export const ACTION_TTL_MINUTES = 30;
export const MAX_AWAITING_ACTIONS = 20;
export const QUIZ_SESSION_MINUTES = 120;

export const READ_SCOPE = "canvas:read";
export const WRITE_SCOPE = "canvas:write";
export const canPropose = (scopes: readonly string[]) => scopes.includes(WRITE_SCOPE);

/** Which auto-mode category covers each staged tool (null = never auto, always approval or immediate). */
export const TOOL_CATEGORY: Record<string, AutoCategory | null> = {
  submit_assignment: "submit_assignment",
  reply_to_discussion: "outward_messages",
  send_message: "outward_messages",
  start_quiz_attempt: "quiz_entry",
};

export const isAutoCategory = (value: unknown): value is AutoCategory => typeof value === "string" && (AUTO_CATEGORIES as readonly string[]).includes(value);

/** Plain-words consent text for the write scope (OAuth consent + PAT checkbox). */
export const WRITE_SCOPE_TEXT = "Propose actions for you, such as submitting an assignment. Nothing is sent until you approve it in Canvas Grove, unless you turn on auto mode for this connection.";
export const READ_SCOPE_TEXT = "Read your courses, assignments, grades and course content.";
