// Pure model for the Approvals UI. No React. Contract: docs/MCP_CONTRACT_PHASE2.md.

// --- Categories -----------------------------------------------------------------------------
import { AUTO_CATEGORIES, AUTO_CAPS, CATEGORY_INFO, DEFAULT_AUTO_CATEGORIES, type AutoCategory } from "@/lib/mcp/categories";
export type ActionCategory = AutoCategory;
export const CATEGORIES: ReadonlyArray<{ id: ActionCategory; label: string; does: string }> = AUTO_CATEGORIES.map(id => ({ id, label: CATEGORY_INFO[id].label, does: CATEGORY_INFO[id].description }));
export const DEFAULT_CATEGORIES: ActionCategory[] = [...DEFAULT_AUTO_CATEGORIES];
export const HOURLY_CAP = AUTO_CAPS.perHour;
export const DAILY_CAP = AUTO_CAPS.perDay;
export const categoryLabel = (id: string) => CATEGORIES.find(category => category.id === id)?.label ?? id.replace(/_/g, " ");

// --- Shapes ----------------------------------------------------------------------------------
export type ActionStatus = "awaiting_approval" | "approved" | "rejected" | "executing" | "done" | "failed" | "expired" | "cancelled";
export type DecidedBy = "you" | "auto" | "system";
export type PreviewLine = { label: string; value: string };
export type ApprovalAction = {
  id: string; tool: string; category: string; title: string; summary: string;
  preview: { lines: PreviewLine[]; warning?: string };
  client: { name: string; connectionId: string; kind: "token" | "grant" };
  status: ActionStatus; decidedBy: DecidedBy | null;
  createdAt: string; expiresAt: string; decidedAt: string | null;
  result?: { ok: boolean; message: string };
};
export type ActionsPayload = { awaitingCount: number; actions: ApprovalAction[] };

// --- Time ------------------------------------------------------------------------------------
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0 min";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
export type TimeLeft = { expired: boolean; urgent: boolean; label: string };
export function timeLeft(expiresAt: string, now: number): TimeLeft {
  const ms = new Date(expiresAt).getTime() - now;
  if (!(ms > 0)) return { expired: true, urgent: false, label: "Expired" };
  return { expired: false, urgent: ms < 5 * 60_000, label: `${formatRemaining(ms)} left` };
}

// --- Words -----------------------------------------------------------------------------------
export function quizConsequence(assistant: string): string {
  return `Let ${assistant} take this quiz: it can read the questions, answer them and submit this attempt.`;
}
/** One plain sentence about what approving does. */
export function consequenceFor(action: ApprovalAction): string {
  if (action.category === "quiz_entry") return action.summary || quizConsequence(action.client.name);
  return `${action.client.name} wants to: ${action.summary}`;
}
export function badgeFor(action: ApprovalAction): { text: string; tone: "you" | "auto" | "muted" } {
  if (action.status === "expired") return { text: "Expired", tone: "muted" };
  if (action.decidedBy === "auto") return { text: "Auto", tone: "auto" };
  if (action.decidedBy === "you") return { text: "You", tone: "you" };
  if (action.status === "cancelled") return { text: "Cancelled", tone: "muted" };
  return { text: "System", tone: "muted" };
}
const STATUS_TEXT: Record<ActionStatus, string> = { awaiting_approval: "Waiting", approved: "Approved", rejected: "Rejected", executing: "Running", done: "Done", failed: "Failed", expired: "Expired", cancelled: "Cancelled" };
export const statusText = (status: ActionStatus) => STATUS_TEXT[status];

export type DecisionProblem = "already_decided" | "expired" | "error";
export function classifyDecisionStatus(status: number): DecisionProblem {
  return status === 409 ? "already_decided" : status === 410 ? "expired" : "error";
}
export const problemMessage: Record<DecisionProblem, string> = {
  already_decided: "That action was already decided, so nothing changed.",
  expired: "That action expired before it was decided. Ask your assistant to propose it again.",
  error: "Could not save your decision. Nothing was changed. Try again.",
};

/** J/K movement within a list of `length` items from `current` (-1 = none). */
export function moveIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, current + delta));
}
/** Where focus should go after removing the item at `index` from a list of `length`. */
export function indexAfterRemoval(index: number, length: number): number {
  return length <= 1 ? -1 : Math.min(index, length - 2);
}
