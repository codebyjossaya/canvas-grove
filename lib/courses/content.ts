import "server-only";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import { announcements, assignmentGroups, assignments, canvasAccounts, courseFiles, courseFolders, courseModuleItems, courseModules, coursePages, courses, courseTabs, plannerItems, submissions } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/db/auth-context";

const nativeByTab: Record<string, string> = { home: "overview", assignments: "assignments", announcements: "announcements", files: "files", syllabus: "syllabus", modules: "modules", pages: "pages", grades: "grades" };
function safeCanvasUrl(value: string | null, origin: string) {
  if (!value) return null;
  try { const url = new URL(value, origin); return url.origin === new URL(origin).origin && url.protocol === "https:" ? url.toString() : null; } catch { return null; }
}
async function ownedCourse(ctx: AuthContext, courseId: string) {
  return withTenantTransaction(ctx.ownerId, async (tx) => (await tx.select({ course: courses, canvasOrigin: canvasAccounts.canvasBaseUrl }).from(courses)
    .innerJoin(canvasAccounts, and(eq(canvasAccounts.ownerId, ctx.ownerId), eq(canvasAccounts.id, courses.canvasAccountId)))
    .where(and(eq(courses.ownerId, ctx.ownerId), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1))[0] ?? null);
}
function courseModel(row: Awaited<ReturnType<typeof ownedCourse>>) {
  return row && { id: row.course.id, name: row.course.name, courseCode: row.course.courseCode, canvasUrl: safeCanvasUrl("/courses/" + row.course.canvasCourseId, row.canvasOrigin) };
}
export async function listCourseTabs(ctx: AuthContext, courseId: string) {
  const owned = await ownedCourse(ctx, courseId); if (!owned) return null;
  const rows = await withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(courseTabs).where(and(eq(courseTabs.ownerId, ctx.ownerId), eq(courseTabs.courseId, courseId), isNull(courseTabs.deletedAt))).orderBy(asc(courseTabs.position), courseTabs.label));
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
export type CourseSection = "overview" | "assignments" | "announcements" | "files" | "syllabus" | "modules" | "pages" | "grades";
export const courseSections = new Set<CourseSection>(["overview", "assignments", "announcements", "files", "syllabus", "modules", "pages", "grades"]);

export async function getCourseSection(ctx: AuthContext, courseId: string, section: CourseSection) {
  const owned = await ownedCourse(ctx, courseId); if (!owned) return null;
  const result = await withTenantTransaction(ctx.ownerId, async (tx) => {
    if (section === "overview") {
      const [upcoming, news] = await Promise.all([
        tx.select().from(assignments).where(and(eq(assignments.ownerId, ctx.ownerId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt)).limit(8),
        tx.select().from(announcements).where(and(eq(announcements.ownerId, ctx.ownerId), eq(announcements.courseId, courseId))).orderBy(desc(announcements.postedAt)).limit(4),
      ]); return { data: { upcoming, announcements: news }, syncedAt: owned.course.syncedAt };
    }
    if (section === "assignments") {
      const rows = await tx.select().from(assignments).where(and(eq(assignments.ownerId, ctx.ownerId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt), assignments.name);
      return { data: { assignments: rows }, syncedAt: rows[0]?.syncedAt ?? owned.course.syncedAt };
    }
    if (section === "announcements") {
      const rows = await tx.select().from(announcements).where(and(eq(announcements.ownerId, ctx.ownerId), eq(announcements.courseId, courseId))).orderBy(desc(announcements.postedAt));
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
      return { data: { html: owned.course.syllabusBody, calendar: calendar.map((item) => ({ ...item, type: item.kind, url: "/courses/" + courseId + "/assignments" })) }, syncedAt: owned.course.syllabusSyncedAt ?? owned.course.syncedAt };
    }
    if (section === "modules") {
      const modules = await tx.select().from(courseModules).where(and(eq(courseModules.ownerId, ctx.ownerId), eq(courseModules.courseId, courseId), isNull(courseModules.deletedAt))).orderBy(asc(courseModules.position));
      const output = [];
      for (const courseModule of modules) {
        const items = await tx.select().from(courseModuleItems).where(and(eq(courseModuleItems.ownerId, ctx.ownerId), eq(courseModuleItems.moduleId, courseModule.id), isNull(courseModuleItems.deletedAt))).orderBy(asc(courseModuleItems.position));
        output.push({ id: courseModule.id, name: courseModule.name, position: courseModule.position, state: courseModule.state, items: items.map((item) => ({ id: item.id, title: item.title, position: item.position, type: item.itemType,
          nativePath: item.itemType === "Page" && item.pageUrl ? "/courses/" + courseId + "/pages#" + encodeURIComponent(item.pageUrl) : null, canvasUrl: safeCanvasUrl(item.htmlUrl, owned.canvasOrigin), completed: item.completed })) });
      } return { data: { modules: output }, syncedAt: modules[0]?.syncedAt ?? owned.course.syncedAt };
    }
    if (section === "pages") {
      const rows = await tx.select().from(coursePages).where(and(eq(coursePages.ownerId, ctx.ownerId), eq(coursePages.courseId, courseId), isNull(coursePages.deletedAt))).orderBy(coursePages.title);
      return { data: { pages: rows.map((row) => ({ slug: row.canvasPageUrl, title: row.title, updatedAt: row.sourceUpdatedAt, html: row.bodyHtml, canvasUrl: safeCanvasUrl(row.htmlUrl, owned.canvasOrigin) })) }, syncedAt: rows[0]?.syncedAt ?? owned.course.syncedAt };
    }
    return { data: await gradeData(tx, ctx.ownerId, courseId), syncedAt: owned.course.syncedAt };
  });
  return { course: courseModel(owned), section, data: result.data, lastSyncedAt: result.syncedAt, stale: Date.now() - result.syncedAt.getTime() > 3_600_000 };
}

type TenantTx = Parameters<Parameters<typeof withTenantTransaction>[1]>[0];
export async function gradeData(tx: TenantTx, ownerId: string, courseId: string) {
  const [groupRows, assignmentRows] = await Promise.all([
    tx.select().from(assignmentGroups).where(and(eq(assignmentGroups.ownerId, ownerId), eq(assignmentGroups.courseId, courseId), isNull(assignmentGroups.deletedAt))).orderBy(asc(assignmentGroups.position)),
    tx.select({ assignment: assignments, submission: submissions }).from(assignments).leftJoin(submissions, and(eq(submissions.ownerId, ownerId), eq(submissions.assignmentId, assignments.id)))
      .where(and(eq(assignments.ownerId, ownerId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt)),
  ]); return { groups: groupRows, assignments: assignmentRows };
}
