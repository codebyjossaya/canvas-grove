import "server-only";
import { withTenantSql } from "@/lib/db";
import type { ActionRow, ExecResult, Executor } from "./actions";
import { executeStartQuiz } from "./quiz-core";

// Executors for staged tools, run only after approval (or auto mode).
//
// Live:        start_quiz_attempt (Grove's quiz service, the same path Grove's own Quiz Mode uses).
// NOT_SUPPORTED_YET (staged, previewed and approvable, but execution refuses and the tools are
// hidden from tools/list):
//   submit_assignment   Grove's operation registry disables `assignment.submit`; there is no
//                       verified submission path (text/URL/upload) in the session client.
//   reply_to_discussion `discussion.reply` exists only as an unused bridge definition; Grove does
//   send_message        not sync discussions/conversations, so it cannot preview the target or
//                       re-check that replies are still allowed. Not exercised against Canvas.

export const EXECUTABLE_TOOLS = new Set(["start_quiz_attempt"]);
export const STAGED_ONLY_TOOLS = ["submit_assignment", "reply_to_discussion", "send_message"] as const;

const notSupported = (what: string): ExecResult => ({ ok: false, code: "NOT_SUPPORTED_YET", message: `${what} is not supported by Canvas Grove yet. Nothing was sent to Canvas.` });

/** Execution-time re-check for an assignment submission (target still open), then refuse. */
const submitAssignment: Executor = async (ctx, action: ActionRow) => {
  const assignmentId = String(action.args.assignmentId ?? "");
  const [row] = await withTenantSql(ctx.ownerId, (tx) => tx<{ lock_at: string | null; deleted_at: string | null }[]>`
    select lock_at, deleted_at from assignments where owner_id = ${ctx.ownerId} and id::text = ${assignmentId}`);
  if (!row || row.deleted_at) return { ok: false, code: "TARGET_GONE", message: "This assignment no longer exists." };
  if (row.lock_at && new Date(row.lock_at).getTime() <= Date.now()) return { ok: false, code: "TARGET_LOCKED", message: "This assignment is now locked. Nothing was sent." };
  return notSupported("Submitting assignments");
};

const EXECUTORS: Record<string, Executor> = {
  start_quiz_attempt: executeStartQuiz,
  submit_assignment: submitAssignment,
  reply_to_discussion: async () => notSupported("Replying to discussions"),
  send_message: async () => notSupported("Sending Canvas messages"),
};

export function executorFor(tool: string): Executor {
  return EXECUTORS[tool] ?? (async () => ({ ok: false, code: "UNKNOWN_TOOL", message: "This action type is not recognised. Nothing was sent." }));
}
