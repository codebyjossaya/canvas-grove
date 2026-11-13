import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { withTenantTransaction } from "@/lib/db";
import { assignments, coursePages, courses, quizzes } from "@/lib/db/schema";
import { assignmentHref } from "./assignment-detail-core";
import { canvasReferences, type CanvasLinkResolver } from "./canvas-html";

type TenantTx = Parameters<Parameters<typeof withTenantTransaction>[1]>[0];

const SECTIONS = new Set(["assignments", "announcements", "files", "modules", "pages", "grades", "syllabus"]);

/**
 * Builds a resolver that maps Canvas URLs found in `htmls` to Grove routes, using the owner's
 * synced rows (one query per kind, tenant-scoped). Unknown targets resolve to null and stay
 * Canvas links.
 */
export async function buildCanvasLinkResolver(tx: TenantTx, ownerId: string, canvasOrigin: string | null, htmls: Array<string | null | undefined>): Promise<CanvasLinkResolver> {
  let origin: string | null = null;
  try { origin = canvasOrigin ? new URL(canvasOrigin).origin : null; } catch { origin = null; }
  const refs = canvasReferences(htmls, origin);
  if (!origin || !refs.courses.size) return () => null;
  const courseRows = await tx.select({ id: courses.id, canvasCourseId: courses.canvasCourseId }).from(courses)
    .where(and(eq(courses.ownerId, ownerId), inArray(courses.canvasCourseId, [...refs.courses]), isNull(courses.deletedAt)));
  const courseByCanvas = new Map(courseRows.map((row) => [row.canvasCourseId, row.id]));
  const courseIds = courseRows.map((row) => row.id);
  const [assignmentRows, quizRows, pageRows] = courseIds.length ? await Promise.all([
    refs.assignments.size ? tx.select({ id: assignments.id, courseId: assignments.courseId, canvasId: assignments.canvasAssignmentId }).from(assignments)
      .where(and(eq(assignments.ownerId, ownerId), inArray(assignments.courseId, courseIds), inArray(assignments.canvasAssignmentId, [...refs.assignments]), isNull(assignments.deletedAt))) : Promise.resolve([]),
    refs.quizzes.size || refs.assignments.size ? tx.select({ id: quizzes.id, courseId: quizzes.courseId, canvasId: quizzes.canvasQuizId, canvasAssignmentId: quizzes.canvasAssignmentId, supported: quizzes.supported }).from(quizzes)
      .where(and(eq(quizzes.ownerId, ownerId), inArray(quizzes.courseId, courseIds), isNull(quizzes.deletedAt))) : Promise.resolve([]),
    refs.pages.size ? tx.select({ courseId: coursePages.courseId, slug: coursePages.canvasPageUrl }).from(coursePages)
      .where(and(eq(coursePages.ownerId, ownerId), inArray(coursePages.courseId, courseIds), isNull(coursePages.deletedAt))) : Promise.resolve([]),
  ]) : [[], [], []];
  const key = (courseId: string, id: string) => `${courseId}|${id}`;
  const quizByCanvas = new Map(quizRows.map((row) => [key(row.courseId, row.canvasId), row.id]));
  // A quiz's assignment link (Canvas lists classic quizzes as assignments too) opens Quiz Mode.
  const quizByAssignment = new Map(quizRows.filter((row) => row.canvasAssignmentId && row.supported).map((row) => [key(row.courseId, row.canvasAssignmentId!), row.id]));
  const assignmentByCanvas = new Map(assignmentRows.map((row) => [key(row.courseId, row.canvasId), row.id]));
  const pageSet = new Set(pageRows.map((row) => key(row.courseId, row.slug)));

  return (url: URL) => {
    if (url.origin !== origin) return null;
    const match = /^\/courses\/(\d{1,20})(?:\/([a-z_]+)(?:\/([^/?#]+))?(?:\/([^?#]*))?)?\/?$/.exec(url.pathname);
    if (!match) return null;
    const courseId = courseByCanvas.get(match[1]);
    if (!courseId) return null;
    const [, , section, item] = match;
    const base = `/courses/${courseId}`;
    if (!section) return base;
    if (section === "assignments" && item === "syllabus") return `${base}/syllabus`;
    if (section === "assignments" && item && /^\d+$/.test(item)) {
      const quiz = quizByAssignment.get(key(courseId, item));
      if (quiz) return `/quizzes/${quiz}`;
      const assignment = assignmentByCanvas.get(key(courseId, item));
      return assignment ? assignmentHref(courseId, assignment) : null;
    }
    if (section === "quizzes" && item && /^\d+$/.test(item)) { const quiz = quizByCanvas.get(key(courseId, item)); return quiz ? `/quizzes/${quiz}` : null; }
    if (section === "pages" && item) { const slug = decodeURIComponent(item); return pageSet.has(key(courseId, slug)) ? `${base}/pages#${encodeURIComponent(slug)}` : null; }
    if (section === "files" && item === "folder") return `${base}/files`;
    if (section === "wiki" && !item) return `${base}/pages`;
    if (!item && SECTIONS.has(section)) return `${base}/${section}`;
    return null;
  };
}
