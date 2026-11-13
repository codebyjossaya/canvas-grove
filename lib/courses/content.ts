import "server-only";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import { announcements, assignmentGroups, assignments, canvasAccounts, courseFiles, courseFolders, courseModuleItems, courseModules, coursePages, courses, courseTabs, plannerItems, submissions } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/db/auth-context";
import { buildWorkItems, num } from "@/lib/views/build";
import { renderCanvasHtml, type CanvasLinkResolver } from "@/lib/views/canvas-html";
import { buildCanvasLinkResolver } from "@/lib/views/canvas-links";

const nativeByTab: Record<string, string> = { home: "overview", assignments: "assignments", announcements: "announcements", files: "files", syllabus: "syllabus", modules: "modules", pages: "pages", grades: "grades" };
function safeCanvasUrl(value: string | null, origin: string) {
  if (!value) return null;
  try { const url = new URL(value, origin); return url.origin === new URL(origin).origin && url.protocol === "https:" ? url.toString() : null; } catch { return null; }
}
function omit<T extends object, K extends keyof T>(source: T, keys: K[]): Omit<T, K> {
  const copy = { ...source }; for (const key of keys) delete copy[key]; return copy;
}
/** List views never render the raw Canvas description or payload, which are the bulk of an assignment row. */
const assignmentListColumns = omit(getTableColumns(assignments), ["descriptionHtml", "sourcePayload"]);

/** Everything below runs in ONE tenant transaction (one connection, one set_config) per request. */
async function ownedCourseIn(tx: TenantTx, ownerId: string, courseId: string, withSyllabus = false) {
  // The syllabus body can be large; only the syllabus section reads it.
  const [row] = await tx.select({ course: { ...getTableColumns(courses), syllabusBody: withSyllabus ? courses.syllabusBody : sql<string | null>`null` }, canvasOrigin: canvasAccounts.canvasBaseUrl }).from(courses)
    .innerJoin(canvasAccounts, and(eq(canvasAccounts.ownerId, ownerId), eq(canvasAccounts.id, courses.canvasAccountId)))
    .where(and(eq(courses.ownerId, ownerId), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1);
  return row ?? null;
}
/** Raw HTML is only sent when the rendered form is empty (the client falls back to plain paragraphs). */
function bodyFields(bodyHtml: string | null, origin: string, resolve: CanvasLinkResolver) {
  const renderedHtml = renderCanvasHtml(bodyHtml, origin, resolve);
  return { renderedHtml, raw: renderedHtml ? undefined : bodyHtml };
}
function courseModel(row: Awaited<ReturnType<typeof ownedCourseIn>>) {
  return row && { id: row.course.id, name: row.course.name, courseCode: row.course.courseCode, canvasUrl: safeCanvasUrl("/courses/" + row.course.canvasCourseId, row.canvasOrigin), currentScore: num(row.course.currentScore), currentGrade: row.course.currentGrade };
}
export async function listCourseTabs(ctx: AuthContext, courseId: string) {
  const found = await withTenantTransaction(ctx.ownerId, async (tx) => {
    const owned = await ownedCourseIn(tx, ctx.ownerId, courseId); if (!owned) return null;
    const rows = await tx.select().from(courseTabs).where(and(eq(courseTabs.ownerId, ctx.ownerId), eq(courseTabs.courseId, courseId), isNull(courseTabs.deletedAt))).orderBy(asc(courseTabs.position), courseTabs.label);
    return { owned, rows };
  });
  if (!found) return null;
  const { owned, rows } = found;
  const tabs = rows.filter((row) => !row.hidden).map((row) => {
    const nativeSection = nativeByTab[row.canvasTabId] ?? null;
    return { id: row.canvasTabId, label: row.label, position: row.position, hidden: row.hidden, type: nativeSection ? "native" as const : "external" as const,
      nativePath: nativeSection ? "/courses/" + courseId + "/" + nativeSection : null,
      canvasUrl: safeCanvasUrl(row.htmlUrl, owned.canvasOrigin) ?? safeCanvasUrl("/courses/" + owned.course.canvasCourseId + "/" + row.canvasTabId, owned.canvasOrigin) };
  });
  const lastSyncedAt = rows.reduce<Date | null>((latest, row) => !latest || row.syncedAt > latest ? row.syncedAt : latest, null);
  return { course: courseModel(owned), tabs, lastSyncedAt, stale: !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > 3_600_000 };
}
export async function getCourseFileDownload(ctx: AuthContext, courseId: string, fileId: string) {
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const row = (await tx.select({ canvasFileId: courseFiles.canvasFileId, canvasOrigin: canvasAccounts.canvasBaseUrl }).from(courseFiles)
      .innerJoin(courses, and(eq(courses.ownerId, ctx.ownerId), eq(courses.id, courseFiles.courseId)))
      .innerJoin(canvasAccounts, and(eq(canvasAccounts.ownerId, ctx.ownerId), eq(canvasAccounts.id, courses.canvasAccountId)))
      .where(and(eq(courseFiles.ownerId, ctx.ownerId), eq(courseFiles.courseId, courseId), eq(courseFiles.id, fileId), isNull(courseFiles.deletedAt))).limit(1))[0];
    return row ? safeCanvasUrl("/files/" + row.canvasFileId + "/download", row.canvasOrigin) : null;
  });
}
/** Canvas file id for one of the owner's synced course files (the proxy fetches it with the user's Canvas session). */
export async function getCourseFileCanvasId(ctx: AuthContext, courseId: string, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(courseId) || !/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  return withTenantTransaction(ctx.ownerId, async (tx) => (await tx.select({ canvasFileId: courseFiles.canvasFileId }).from(courseFiles)
    .where(and(eq(courseFiles.ownerId, ctx.ownerId), eq(courseFiles.courseId, courseId), eq(courseFiles.id, fileId), isNull(courseFiles.deletedAt))).limit(1))[0]?.canvasFileId ?? null);
}
export type CourseSection = "overview" | "assignments" | "announcements" | "files" | "syllabus" | "modules" | "pages" | "grades";
export const courseSections = new Set<CourseSection>(["overview", "assignments", "announcements", "files", "syllabus", "modules", "pages", "grades"]);

export async function getCourseSection(ctx: AuthContext, courseId: string, section: CourseSection) {
  return withTenantTransaction(ctx.ownerId, async (tx) => {
  const owned = await ownedCourseIn(tx, ctx.ownerId, courseId, section === "syllabus"); if (!owned) return null;
  const result = await (async () => {
    if (section === "overview" || section === "assignments") {
      // Assignments carry their latest submission state so the course pages can show what is
      // done, overdue or graded (built by the same pure builder as Today and the Planner).
      const [rows, submissionRows, news] = await Promise.all([
        tx.select(assignmentListColumns).from(assignments).where(and(eq(assignments.ownerId, ctx.ownerId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt), assignments.name),
        tx.select({ assignmentId: submissions.assignmentId, attempt: submissions.attempt, state: submissions.state, submittedAt: submissions.submittedAt, gradedAt: submissions.gradedAt, score: submissions.score, grade: submissions.grade, late: submissions.late, missing: submissions.missing, excused: submissions.excused })
          .from(submissions).innerJoin(assignments, and(eq(assignments.ownerId, ctx.ownerId), eq(assignments.id, submissions.assignmentId)))
          .where(and(eq(submissions.ownerId, ctx.ownerId), eq(assignments.courseId, courseId))),
        section === "overview" ? tx.select({ id: announcements.id, title: announcements.title, bodyHtml: announcements.bodyHtml, postedAt: announcements.postedAt, htmlUrl: announcements.htmlUrl }).from(announcements).where(and(eq(announcements.ownerId, ctx.ownerId), eq(announcements.courseId, courseId))).orderBy(desc(announcements.postedAt)).limit(4) : Promise.resolve([]),
      ]);
      const now = new Date();
      const items = buildWorkItems({ canvasOrigin: owned.canvasOrigin, courses: [owned.course], assignments: rows, submissions: submissionRows, planner: [], announcements: [], conversations: [] }, now);
      const syncedAt = rows.reduce<Date | null>((latest, row) => !latest || row.syncedAt > latest ? row.syncedAt : latest, null) ?? owned.course.syncedAt;
      if (section === "assignments") return { data: { items }, syncedAt };
      const upcoming = items.filter(item => item.dueAt && new Date(item.dueAt).getTime() >= now.getTime() - 86_400_000).slice(0, 8);
      const overdue = items.filter(item => item.state === "overdue" || item.state === "missing");
      return { data: { upcoming, overdue, announcements: news }, syncedAt };
    }
    if (section === "announcements") {
      const raw = await tx.select({ id: announcements.id, title: announcements.title, bodyHtml: announcements.bodyHtml, postedAt: announcements.postedAt, htmlUrl: announcements.htmlUrl, syncedAt: announcements.syncedAt }).from(announcements).where(and(eq(announcements.ownerId, ctx.ownerId), eq(announcements.courseId, courseId))).orderBy(desc(announcements.postedAt));
      const resolve = await buildCanvasLinkResolver(tx, ctx.ownerId, owned.canvasOrigin, raw.map((row) => row.bodyHtml));
      const rows = raw.map(({ bodyHtml, ...row }) => { const body = bodyFields(bodyHtml, owned.canvasOrigin, resolve); return { ...row, bodyHtml: body.raw, renderedHtml: body.renderedHtml }; });
      return { data: { announcements: rows }, syncedAt: rows[0]?.syncedAt ?? owned.course.syncedAt };
    }
    if (section === "files") {
      const [folders, files] = await Promise.all([
        tx.select().from(courseFolders).where(and(eq(courseFolders.ownerId, ctx.ownerId), eq(courseFolders.courseId, courseId), isNull(courseFolders.deletedAt))).orderBy(courseFolders.fullName),
        tx.select().from(courseFiles).where(and(eq(courseFiles.ownerId, ctx.ownerId), eq(courseFiles.courseId, courseId), isNull(courseFiles.deletedAt))).orderBy(courseFiles.displayName),
      ]);
      return { data: { folders: folders.map((row) => ({ id: row.canvasFolderId, parentId: row.parentCanvasFolderId, name: row.name, fullName: row.fullName, filesCount: row.filesCount, foldersCount: row.foldersCount })),
        files: files.map((row) => ({ id: row.id, folderId: row.canvasFolderId, displayName: row.displayName, contentType: row.contentType, size: row.size, updatedAt: row.sourceUpdatedAt,
          downloadPath: "/api/canvas/courses/" + courseId + "/files/" + row.id + "/download", canvasUrl: safeCanvasUrl("/courses/" + owned.course.canvasCourseId + "/files/" + row.canvasFileId, owned.canvasOrigin) })) },
        syncedAt: [...folders, ...files].reduce<Date | null>((latest, row) => !latest || row.syncedAt > latest ? row.syncedAt : latest, null) ?? owned.course.syncedAt };
    }
    if (section === "syllabus") {
      const calendar = await tx.select({ id: plannerItems.id, title: plannerItems.title, dueAt: plannerItems.dueAt, kind: plannerItems.kind }).from(plannerItems)
        .where(and(eq(plannerItems.ownerId, ctx.ownerId), eq(plannerItems.courseId, courseId), isNull(plannerItems.deletedAt))).orderBy(asc(plannerItems.dueAt)).limit(50);
      const resolve = await buildCanvasLinkResolver(tx, ctx.ownerId, owned.canvasOrigin, [owned.course.syllabusBody]);
      return { data: { html: bodyFields(owned.course.syllabusBody, owned.canvasOrigin, resolve).raw, renderedHtml: bodyFields(owned.course.syllabusBody, owned.canvasOrigin, resolve).renderedHtml, calendar: calendar.map((item) => ({ ...item, type: item.kind, url: "/courses/" + courseId + "/assignments" })) }, syncedAt: owned.course.syllabusSyncedAt ?? owned.course.syncedAt };
    }
    if (section === "modules") {
      const modules = await tx.select().from(courseModules).where(and(eq(courseModules.ownerId, ctx.ownerId), eq(courseModules.courseId, courseId), isNull(courseModules.deletedAt))).orderBy(asc(courseModules.position));
      const allItems = modules.length ? await tx.select().from(courseModuleItems).where(and(eq(courseModuleItems.ownerId, ctx.ownerId), inArray(courseModuleItems.moduleId, modules.map((row) => row.id)), isNull(courseModuleItems.deletedAt))).orderBy(asc(courseModuleItems.position)) : [];
      const output = [];
      for (const courseModule of modules) {
        const items = allItems.filter((item) => item.moduleId === courseModule.id);
        output.push({ id: courseModule.id, name: courseModule.name, position: courseModule.position, state: courseModule.state, items: items.map((item) => ({ id: item.id, title: item.title, position: item.position, type: item.itemType,
          nativePath: item.itemType === "Page" && item.pageUrl ? "/courses/" + courseId + "/pages#" + encodeURIComponent(item.pageUrl) : null, canvasUrl: safeCanvasUrl(item.htmlUrl, owned.canvasOrigin), completed: item.completed })) });
      } return { data: { modules: output }, syncedAt: modules[0]?.syncedAt ?? owned.course.syncedAt };
    }
    if (section === "pages") {
      const rows = await tx.select({ canvasPageUrl: coursePages.canvasPageUrl, title: coursePages.title, sourceUpdatedAt: coursePages.sourceUpdatedAt, bodyHtml: coursePages.bodyHtml, htmlUrl: coursePages.htmlUrl, syncedAt: coursePages.syncedAt }).from(coursePages).where(and(eq(coursePages.ownerId, ctx.ownerId), eq(coursePages.courseId, courseId), isNull(coursePages.deletedAt))).orderBy(coursePages.title);
      const resolve = await buildCanvasLinkResolver(tx, ctx.ownerId, owned.canvasOrigin, rows.map((row) => row.bodyHtml));
      return { data: { pages: rows.map((row) => { const body = bodyFields(row.bodyHtml, owned.canvasOrigin, resolve); return { slug: row.canvasPageUrl, title: row.title, updatedAt: row.sourceUpdatedAt, html: body.raw, renderedHtml: body.renderedHtml, canvasUrl: safeCanvasUrl(row.htmlUrl, owned.canvasOrigin) }; }) }, syncedAt: rows[0]?.syncedAt ?? owned.course.syncedAt };
    }
    return { data: {}, syncedAt: owned.course.syncedAt };
  })();
  return { course: courseModel(owned), section, data: result.data, lastSyncedAt: result.syncedAt, stale: Date.now() - result.syncedAt.getTime() > 3_600_000 };
  });
}

type TenantTx = Parameters<Parameters<typeof withTenantTransaction>[1]>[0];
export async function gradeData(tx: TenantTx, ownerId: string, courseId: string) {
  const [groupRows, assignmentRows] = await Promise.all([
    tx.select().from(assignmentGroups).where(and(eq(assignmentGroups.ownerId, ownerId), eq(assignmentGroups.courseId, courseId), isNull(assignmentGroups.deletedAt))).orderBy(asc(assignmentGroups.position)),
    tx.select({ assignment: assignments, submission: submissions }).from(assignments).leftJoin(submissions, and(eq(submissions.ownerId, ownerId), eq(submissions.assignmentId, assignments.id)))
      .where(and(eq(assignments.ownerId, ownerId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt)),
  ]); return { groups: groupRows, assignments: assignmentRows };
}
