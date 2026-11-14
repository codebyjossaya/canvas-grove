import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { assignments, canvasAccounts, courses, quizzes, submissions } from "@/lib/db/schema";
import { assignmentHref, isUuid, renderCanvasHtml, submissionLabel } from "./assignment-detail-core";
import { buildCanvasLinkResolver } from "./canvas-links";
import { safeHttpsUrl } from "./text";

export { assignmentHref };

export type AssignmentDetail = {
  id: string; courseId: string; courseName: string; courseCode: string | null; title: string;
  dueAt: string | null; unlockAt: string | null; lockAt: string | null; points: number | null;
  submissionTypes: string[]; status: string | null; submitted: boolean; descriptionHtml: string; canvasUrl: string | null;
  /** Grove Quiz Mode route when this assignment is a quiz Grove can run natively. */
  quizHref: string | null;
  /** Work happens in an external tool (LTI) that only Canvas can launch. */
  externalTool: boolean;
  /** Fast local UX gate only; the submit service re-checks the current Canvas assignment. */
  submissionAdvisory: string | null;
  syncedAt: string | null;
};

const iso = (value: Date | string | null | undefined) => { if (!value) return null; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; };
const num = (value: unknown) => { if (value == null || value === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };

/** One assignment for the signed-in tenant, or null when it does not exist or belongs to another course or tenant. */
export async function loadAssignmentDetail(ctx: AuthContext, courseId: string, assignmentId: string): Promise<AssignmentDetail | null> {
  if (!isUuid(courseId) || !isUuid(assignmentId)) return null;
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const owner = ctx.ownerId;
    // Row, course (+ its Canvas account) and latest submission are independent: one pipelined batch.
    const [[row], [courseJoin], [sub]] = await Promise.all([
      tx.select({ id: assignments.id, name: assignments.name, dueAt: assignments.dueAt, unlockAt: assignments.unlockAt, lockAt: assignments.lockAt, points: assignments.pointsPossible, submissionTypes: assignments.submissionTypes, workflowState: assignments.workflowState, descriptionHtml: assignments.descriptionHtml, payload: assignments.sourcePayload, canvasAssignmentId: assignments.canvasAssignmentId })
      .from(assignments).where(and(eq(assignments.ownerId, owner), eq(assignments.id, assignmentId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).limit(1),
      tx.select({ id: courses.id, name: courses.name, courseCode: courses.courseCode, canvasCourseId: courses.canvasCourseId, origin: canvasAccounts.canvasBaseUrl }).from(courses)
        .leftJoin(canvasAccounts, and(eq(canvasAccounts.ownerId, owner), eq(canvasAccounts.id, courses.canvasAccountId)))
        .where(and(eq(courses.ownerId, owner), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1),
      tx.select({ state: submissions.state, attempt: submissions.attempt, late: submissions.late, missing: submissions.missing, excused: submissions.excused, submittedAt: submissions.submittedAt, score: submissions.score, grade: submissions.grade, syncedAt: submissions.syncedAt })
        .from(submissions).where(and(eq(submissions.ownerId, owner), eq(submissions.assignmentId, assignmentId))).orderBy(desc(submissions.attempt)).limit(1),
    ]);
    if (!row || !courseJoin) return null;
    const course = courseJoin, account = { origin: courseJoin.origin };
    const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
    const payloadUrl = safeHttpsUrl(payload.html_url);
    let origin: string | null = null;
    try { origin = new URL(account?.origin ?? payloadUrl ?? "").origin; } catch { origin = null; }
    const points = num(row.points);
    const fallbackUrl = origin && course.canvasCourseId && row.canvasAssignmentId ? safeHttpsUrl(`${origin}/courses/${course.canvasCourseId}/assignments/${row.canvasAssignmentId}`) : null;
    const rawTypes: unknown = row.submissionTypes;
    const types = Array.isArray(rawTypes) ? rawTypes.filter((t): t is string => typeof t === "string") : typeof rawTypes === "string" && rawTypes ? [rawTypes] : [];
    const rawHtml = row.descriptionHtml ?? (typeof payload.description === "string" ? payload.description : null);
    const [resolve, [quiz]] = await Promise.all([
      buildCanvasLinkResolver(tx, owner, origin, [rawHtml]),
      tx.select({ id: quizzes.id, supported: quizzes.supported }).from(quizzes)
        .where(and(eq(quizzes.ownerId, owner), eq(quizzes.courseId, courseId), eq(quizzes.canvasAssignmentId, row.canvasAssignmentId), isNull(quizzes.deletedAt))).limit(1),
    ]);
    const summary = sub ? { ...sub, submittedAt: iso(sub.submittedAt), score: num(sub.score) } : null;
    const now = Date.now();
    const unlockAt = row.unlockAt ? new Date(row.unlockAt).getTime() : null;
    const lockAt = row.lockAt ? new Date(row.lockAt).getTime() : null;
    const allowedAttempts = payload.allowed_attempts == null || payload.allowed_attempts === "" ? NaN : Number(payload.allowed_attempts);
    const lockExplanation = typeof payload.lock_explanation === "string" ? payload.lock_explanation.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
    const submissionAdvisory = row.workflowState === "unpublished" || payload.published === false
      ? "This assignment is not published in Canvas."
      : payload.locked_for_user === true || lockAt != null && lockAt <= now
        ? lockExplanation || "This assignment is locked in Canvas."
        : unlockAt != null && unlockAt > now
          ? "This assignment is not open yet."
          : summary && Number.isInteger(allowedAttempts) && allowedAttempts >= 0 && summary.attempt >= allowedAttempts
            ? "No submission attempts remain in Canvas."
            : null;
    return {
      id: row.id, courseId: course.id, courseName: course.name, courseCode: course.courseCode ?? null, title: row.name,
      dueAt: iso(row.dueAt), unlockAt: iso(row.unlockAt), lockAt: iso(row.lockAt), points, submissionTypes: types,
      status: submissionLabel(summary, points),
      submitted: Boolean(summary && (summary.submittedAt || ["submitted", "pending_review", "graded"].includes(summary.state ?? ""))),
      descriptionHtml: renderCanvasHtml(rawHtml, origin, resolve),
      canvasUrl: payloadUrl ?? fallbackUrl,
      quizHref: quiz?.supported ? `/quizzes/${quiz.id}` : null,
      externalTool: types.includes("external_tool"),
      submissionAdvisory,
      syncedAt: iso(sub?.syncedAt),
    };
  });
}
