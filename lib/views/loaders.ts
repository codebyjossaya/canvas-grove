import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import {
  announcements, assignments, canvasAccounts, conversationMessages, conversations, courseFiles, courseModuleItems, courseModules,
  coursePages, courses, plannerItems, submissions, userPreferences,
} from "@/lib/db/schema";
import { resolveTimeZone } from "@/lib/time";
import { buildCourses, buildGradesOverview, buildInbox, buildPaletteIndex, buildPlanner, buildSidebarCourses, buildToday, courseRef } from "./build";
import { firstParam, isValidKey } from "./dates";
import { safeHttpsUrl } from "./text";
import type { AssignmentRow, MessageRow, WorkspaceRows } from "./types";

// Read-only view loaders for the redesigned workspace. Every query is tenant scoped through
// withTenantTransaction + an explicit owner predicate, exactly like lib/db/repository.ts.

export const TIMEZONE_COOKIE = "cg_tz";
export const SEEN_AT_COOKIE = "cg_seen_at";
export const SEEN_PREV_COOKIE = "cg_seen_prev";

type Prefs = { zone: string; weekStartsOn: number; firstName: string | null };

type Profile = { pref: { timezone: string | null; weekStartsOn: number | null; orientationVersion: string | null; orientationCompletedAt: Date | null } | undefined; account: { origin: string | null; timezone: string | null; displayName: string | null } | undefined };

/**
 * The owner's preference row and newest Canvas account in ONE tenant transaction, memoized per
 * request. Prefs, workspace rows and the onboarding gate all need them, so a render pays once.
 */
export const loadProfile = cache(async (ownerId: string): Promise<Profile> => withTenantTransaction(ownerId, async (tx) => {
  const [pref, account] = await Promise.all([
    tx.select({ timezone: userPreferences.timezone, weekStartsOn: userPreferences.weekStartsOn, orientationVersion: userPreferences.orientationVersion, orientationCompletedAt: userPreferences.orientationCompletedAt }).from(userPreferences).where(eq(userPreferences.ownerId, ownerId)).limit(1),
    tx.select({ origin: canvasAccounts.canvasBaseUrl, timezone: canvasAccounts.timezone, displayName: canvasAccounts.displayName }).from(canvasAccounts).where(eq(canvasAccounts.ownerId, ownerId)).orderBy(desc(canvasAccounts.updatedAt)).limit(1),
  ]);
  return { pref: pref[0], account: account[0] };
}));

async function preferences(ctx: AuthContext): Promise<Prefs> {
  const [jar, rows] = await Promise.all([cookies(), loadProfile(ctx.ownerId)]);
  // Preference wins; "auto" falls back to this device's zone (set by the shell as a cookie),
  // then the Canvas profile zone, then UTC.
  const zone = resolveTimeZone(rows.pref?.timezone, jar.get(TIMEZONE_COOKIE)?.value ?? rows.account?.timezone ?? undefined);
  const firstName = rows.account?.displayName?.trim().split(/\s+/)[0] ?? null;
  return { zone, weekStartsOn: rows.pref?.weekStartsOn ?? 0, firstName };
}

type AssignmentMeta = { htmlUrl: string | null; quizId: string | null; discussionTopicId: string | null; sourceType: string | null; lockedForUser: boolean | null; inClosedGradingPeriod: boolean | null } | null;
/**
 * Pulls the handful of Canvas identity fields out of source_payload with ONE jsonb_to_record call.
 * The payload is a large TOASTed document (it embeds the description HTML); six separate `->>`
 * operators each decompressed it again (22ms for ~400 rows, now ~6ms).
 */
const assignmentMeta = sql<AssignmentMeta>`(select jsonb_build_object('htmlUrl', r.html_url, 'quizId', r.quiz_id, 'discussionTopicId', r.discussion_topic->>'id', 'sourceType', r.type,
  'lockedForUser', case when jsonb_typeof(r.locked_for_user) = 'boolean' then r.locked_for_user end,
  'inClosedGradingPeriod', case when jsonb_typeof(r.in_closed_grading_period) = 'boolean' then r.in_closed_grading_period end)
  from jsonb_to_record(case when jsonb_typeof(${assignments.sourcePayload}) = 'object' then ${assignments.sourcePayload} else '{}'::jsonb end) as r(html_url text, quiz_id text, type text, discussion_topic jsonb, locked_for_user jsonb, in_closed_grading_period jsonb))`.mapWith((value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as AssignmentMeta);

async function workspaceRows(ctx: AuthContext, options: { announcementsLimit?: number; conversationsLimit?: number; announcementBodies?: boolean } = {}): Promise<WorkspaceRows> {
  const owner = ctx.ownerId, announcementsLimit = options.announcementsLimit ?? 60, conversationsLimit = options.conversationsLimit ?? 60;
  const [profile, data] = await Promise.all([loadProfile(owner), withTenantTransaction(owner, async (tx) => {
    // Independent reads share one connection; postgres.js pipelines them instead of waiting on
    // each round trip in turn.
    const [courseRows, assignmentRows, submissionRows, plannerRows, announcementRows, conversationRows] = await Promise.all([
      tx.select({ id: courses.id, name: courses.name, courseCode: courses.courseCode, termName: courses.termName, workflowState: courses.workflowState, currentScore: courses.currentScore, currentGrade: courses.currentGrade, favorite: courses.favorite, canvasCourseId: courses.canvasCourseId })
        .from(courses).where(and(eq(courses.ownerId, owner), isNull(courses.deletedAt))).orderBy(courses.name),
      tx.select({ id: assignments.id, courseId: assignments.courseId, name: assignments.name, dueAt: assignments.dueAt, pointsPossible: assignments.pointsPossible, submissionTypes: assignments.submissionTypes, workflowState: assignments.workflowState, canvasAssignmentId: assignments.canvasAssignmentId, assignmentGroupId: assignments.assignmentGroupId,
        unlockAt: assignments.unlockAt, lockAt: assignments.lockAt, meta: assignmentMeta })
        .from(assignments).where(and(eq(assignments.ownerId, owner), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt)),
      tx.select({ assignmentId: submissions.assignmentId, attempt: submissions.attempt, state: submissions.state, submittedAt: submissions.submittedAt, gradedAt: submissions.gradedAt, score: submissions.score, grade: submissions.grade, late: submissions.late, missing: submissions.missing, excused: submissions.excused })
        .from(submissions).where(eq(submissions.ownerId, owner)),
      tx.select({ id: plannerItems.id, courseId: plannerItems.courseId, assignmentId: plannerItems.assignmentId, source: plannerItems.source, kind: plannerItems.kind, title: plannerItems.title, startsAt: plannerItems.startsAt, dueAt: plannerItems.dueAt, status: plannerItems.status, canvasItemType: plannerItems.canvasItemType, canvasItemId: plannerItems.canvasItemId })
        .from(plannerItems).where(and(eq(plannerItems.ownerId, owner), isNull(plannerItems.deletedAt))),
      // Announcement bodies are only rendered by the inbox; every other view needs titles and dates.
      announcementsLimit > 0 ? tx.select({ id: announcements.id, courseId: announcements.courseId, title: announcements.title, bodyHtml: options.announcementBodies ? announcements.bodyHtml : sql<string | null>`null`, postedAt: announcements.postedAt, htmlUrl: announcements.htmlUrl })
        .from(announcements).where(eq(announcements.ownerId, owner)).orderBy(desc(announcements.postedAt)).limit(announcementsLimit) : Promise.resolve([]),
      conversationsLimit > 0 ? tx.select({ id: conversations.id, courseId: conversations.courseId, subject: conversations.subject, workflowState: conversations.workflowState, lastMessageAt: conversations.lastMessageAt, messageCount: conversations.messageCount, starred: conversations.starred, participants: conversations.participants })
        .from(conversations).where(eq(conversations.ownerId, owner)).orderBy(desc(conversations.lastMessageAt)).limit(conversationsLimit) : Promise.resolve([]),
    ]);
    return { courseRows, assignmentRows, submissionRows, plannerRows, announcementRows, conversationRows };
  })]);
  const assignmentRows: AssignmentRow[] = data.assignmentRows.map(({ meta, ...row }) => ({ ...row, htmlUrl: meta?.htmlUrl ?? null, quizId: meta?.quizId ?? null, discussionTopicId: meta?.discussionTopicId ?? null, sourceType: meta?.sourceType ?? null, lockedForUser: meta?.lockedForUser ?? null, inClosedGradingPeriod: meta?.inClosedGradingPeriod ?? null }));
  return { canvasOrigin: profile.account?.origin ?? null, courses: data.courseRows, assignments: assignmentRows, submissions: data.submissionRows, planner: data.plannerRows, announcements: data.announcementRows, conversations: data.conversationRows };
}

/** The start of "since you last looked": the previous visit, or the last activity if this
 *  request is the first of a new visit (the client cookie update has not run yet). */
async function lastSeen(now: Date) {
  const jar = await cookies();
  const parse = (name: string) => { const value = jar.get(name)?.value; const date = value ? new Date(decodeURIComponent(value)) : null; return date && Number.isFinite(date.getTime()) ? date : null; };
  const at = parse(SEEN_AT_COOKIE), prev = parse(SEEN_PREV_COOKIE);
  if (at && now.getTime() - at.getTime() > 30 * 60_000) return at;
  return prev;
}

export async function loadTodayView(ctx: AuthContext) {
  const now = new Date();
  const [prefs, rows, since] = await Promise.all([preferences(ctx), workspaceRows(ctx), lastSeen(now)]);
  return buildToday(rows, now, prefs.zone, { since }, prefs.firstName);
}

export async function loadPlannerView(ctx: AuthContext, params: { week?: string | string[]; view?: string | string[] }) {
  const [prefs, rows] = await Promise.all([preferences(ctx), workspaceRows(ctx, { announcementsLimit: 0, conversationsLimit: 0 })]);
  const week = firstParam(params.week);
  return buildPlanner(rows, new Date(), prefs.zone, { weekStart: isValidKey(week) ? week : null, view: firstParam(params.view), weekStartsOn: prefs.weekStartsOn });
}

export async function loadInboxView(ctx: AuthContext, params: { tab?: string; c?: string; a?: string }) {
  const [prefs, rows] = await Promise.all([preferences(ctx), workspaceRows(ctx, { announcementsLimit: 100, conversationsLimit: 100, announcementBodies: true })]);
  const ids = rows.conversations.map(row => row.id);
  const messages: MessageRow[] = ids.length ? await withTenantTransaction(ctx.ownerId, (tx) => tx.select({ id: conversationMessages.id, conversationId: conversationMessages.conversationId, authorName: conversationMessages.authorName, bodyHtml: conversationMessages.bodyHtml, sentAt: conversationMessages.sentAt, attachments: conversationMessages.attachments })
    .from(conversationMessages).where(and(eq(conversationMessages.ownerId, ctx.ownerId), inArray(conversationMessages.conversationId, ids))).orderBy(desc(conversationMessages.sentAt)).limit(600)) : [];
  return buildInbox(rows, messages, { tab: params.tab, thread: params.c, announcement: params.a }, prefs.zone);
}

export async function loadCoursesView(ctx: AuthContext, view: string | undefined) {
  const [prefs, rows] = await Promise.all([preferences(ctx), workspaceRows(ctx, { announcementsLimit: 0, conversationsLimit: 0 })]);
  return buildCourses(rows, new Date(), prefs.zone, view);
}

export async function loadGradesOverview(ctx: AuthContext) {
  return buildGradesOverview(await workspaceRows(ctx, { announcementsLimit: 0, conversationsLimit: 0 }));
}

export async function loadPaletteIndex(ctx: AuthContext) {
  return buildPaletteIndex(await workspaceRows(ctx, { announcementsLimit: 0, conversationsLimit: 0 }), new Date());
}

export async function loadSidebarCourses(ctx: AuthContext) {
  const rows = await withTenantTransaction(ctx.ownerId, (tx) => tx.select({ id: courses.id, name: courses.name, courseCode: courses.courseCode, termName: courses.termName, currentScore: courses.currentScore, currentGrade: courses.currentGrade, favorite: courses.favorite, canvasCourseId: courses.canvasCourseId })
    .from(courses).where(and(eq(courses.ownerId, ctx.ownerId), isNull(courses.deletedAt))).orderBy(courses.name));
  return buildSidebarCourses(rows);
}

export type CourseSearchEntry = { id: string; kind: "assignment" | "page" | "file" | "module" | "announcement"; title: string; detail: string; href: string; external: boolean };

/** Titles of everything synced for one course, for client-side in-course search. */
export async function loadCourseSearchIndex(ctx: AuthContext, courseId: string): Promise<{ course: ReturnType<typeof courseRef>; entries: CourseSearchEntry[] } | null> {
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const owner = ctx.ownerId;
    const [course] = await tx.select({ id: courses.id, name: courses.name, courseCode: courses.courseCode }).from(courses).where(and(eq(courses.ownerId, owner), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1);
    if (!course) return null;
    const [assignmentRows, pageRows, fileRows, moduleRows, announcementRows] = await Promise.all([
      tx.select({ id: assignments.id, name: assignments.name }).from(assignments).where(and(eq(assignments.ownerId, owner), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))),
      tx.select({ id: coursePages.id, title: coursePages.title, slug: coursePages.canvasPageUrl }).from(coursePages).where(and(eq(coursePages.ownerId, owner), eq(coursePages.courseId, courseId), isNull(coursePages.deletedAt))),
      tx.select({ id: courseFiles.id, name: courseFiles.displayName, contentType: courseFiles.contentType }).from(courseFiles).where(and(eq(courseFiles.ownerId, owner), eq(courseFiles.courseId, courseId), isNull(courseFiles.deletedAt))),
      tx.select({ id: courseModuleItems.id, title: courseModuleItems.title, type: courseModuleItems.itemType, htmlUrl: courseModuleItems.htmlUrl, moduleName: courseModules.name })
        .from(courseModuleItems).innerJoin(courseModules, and(eq(courseModules.ownerId, owner), eq(courseModules.id, courseModuleItems.moduleId)))
        .where(and(eq(courseModuleItems.ownerId, owner), eq(courseModules.courseId, courseId), isNull(courseModuleItems.deletedAt), isNull(courseModules.deletedAt))),
      tx.select({ id: announcements.id, title: announcements.title }).from(announcements).where(and(eq(announcements.ownerId, owner), eq(announcements.courseId, courseId))).orderBy(desc(announcements.postedAt)).limit(100),
    ]);
    const base = `/courses/${courseId}`;
    const entries: CourseSearchEntry[] = [
      ...assignmentRows.map(row => ({ id: row.id, kind: "assignment" as const, title: row.name, detail: "Assignment", href: `${base}/assignments`, external: false })),
      ...pageRows.map(row => ({ id: row.id, kind: "page" as const, title: row.title, detail: "Page", href: `${base}/pages#${encodeURIComponent(row.slug)}`, external: false })),
      ...fileRows.map(row => ({ id: row.id, kind: "file" as const, title: row.name, detail: row.contentType ?? "File", href: `/api/canvas/courses/${courseId}/files/${row.id}/download`, external: true })),
      ...moduleRows.map(row => { const url = safeHttpsUrl(row.htmlUrl); return { id: row.id, kind: "module" as const, title: row.title, detail: `${row.moduleName}${row.type ? ` · ${row.type}` : ""}`, href: url ?? `${base}/modules`, external: Boolean(url) }; }),
      ...announcementRows.map(row => ({ id: row.id, kind: "announcement" as const, title: row.title, detail: "Announcement", href: `/inbox?tab=announcements&a=${row.id}`, external: false })),
    ];
    return { course: courseRef(course), entries };
  });
}
