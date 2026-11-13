// Pure helpers for the assignment detail view. No server-only imports so client components
// and unit tests can use them.
export { renderCanvasHtml, canvasProxyHref, type CanvasLinkResolver } from "./canvas-html";

export function assignmentHref(courseId: string, assignmentId: string) {
  return `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`;
}

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export type SubmissionSummary = { state: string | null; late: boolean; missing: boolean; excused: boolean; submittedAt: string | null; score: number | null; grade: string | null };

export function submissionLabel(sub: SubmissionSummary | null, points: number | null) {
  if (!sub) return null;
  if (sub.excused) return "Excused";
  if (sub.score != null && sub.state === "graded") return `Graded: ${sub.score}${points ? ` / ${points}` : ""}${sub.late ? " (late)" : ""}`;
  // Canvas reports external-tool (LTI) work handed in but not yet scored as pending_review, with no submitted_at.
  if (sub.state === "pending_review") return sub.late ? "Submitted late · awaiting grade" : "Submitted · awaiting grade";
  if (sub.missing) return "Missing";
  if (sub.submittedAt || sub.state === "submitted") return sub.late ? "Submitted late" : "Submitted";
  if (sub.state === "unsubmitted") return "Not submitted";
  if (sub.state) return sub.state.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
  return null;
}
