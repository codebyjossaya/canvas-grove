import "server-only";
import type postgres from "postgres";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTenantSql } from "@/lib/db";
import { quizClassification, quizEligibility } from "./action-policy";
import { BODY_CAP, canvasFileIdsIn, fileDownloadPath, fitItems, htmlToText, likePattern, untrusted } from "./content";

// Phase-1 read-only tools over Grove's synced Postgres. Policy (docs/MCP_CONTRACT.md):
//  * never quiz questions/answers (quizzes are metadata only, no descriptions);
//  * no writes; every query runs in withTenantSql(ownerId) (forced RLS);
//  * Canvas-authored text is wrapped as untrusted content;
//  * logs carry tool name, owner id, status and duration only.

type Tx = postgres.TransactionSql;
type Stamp = Date | string | null;
const iso = (value: Stamp) => (value ? new Date(value).toISOString() : null);
const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true } as const;

type Data = Record<string, unknown>;
const ok = (data: Data): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
class ToolError extends Error {}

const courseRef = z.string().min(1).max(64).describe("Course id: the Canvas course id (from list_courses) or Grove's course id");
const limitArg = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt).describe(`Maximum items (1-${max}, default ${dflt})`);
const cursorArg = z.string().regex(/^\d{1,6}$/).optional().describe("Cursor from a previous truncated result");
const offsetOf = (cursor?: string) => (cursor ? Number(cursor) : 0);

async function syncedAt(tx: Tx, ownerId: string): Promise<string | null> {
  const [row] = await tx<{ at: Stamp }[]>`select greatest(
      (select max(last_synced_at) from canvas_accounts where owner_id = ${ownerId}),
      (select max(finished_at) from sync_jobs where owner_id = ${ownerId} and status = 'succeeded')) as at`;
  return iso(row?.at ?? null);
}

type CourseRow = { id: string; canvas_course_id: string; name: string; course_code: string | null; term_name: string | null; workflow_state: string | null; start_at: Stamp; end_at: Stamp; current_score: unknown; current_grade: string | null; favorite: boolean; synced_at: Stamp; syllabus_body?: string | null };
const courseOut = (c: CourseRow) => ({
  courseId: c.canvas_course_id, groveId: c.id, name: c.name, code: c.course_code, term: c.term_name, state: c.workflow_state,
  startAt: iso(c.start_at), endAt: iso(c.end_at), favorite: c.favorite, currentScore: num(c.current_score), currentGrade: c.current_grade,
});

async function resolveCourse(tx: Tx, ownerId: string, ref: string): Promise<CourseRow> {
  const [course] = await tx<CourseRow[]>`select id, canvas_course_id, name, course_code, term_name, workflow_state, start_at, end_at, current_score, current_grade, favorite, synced_at, syllabus_body
    from courses where owner_id = ${ownerId} and deleted_at is null and (canvas_course_id = ${ref} or id::text = ${ref.toLowerCase()}) order by favorite desc limit 1`;
  if (!course) throw new ToolError(`No course "${ref}". Use list_courses to see course ids.`);
  return course;
}

const STATUS = ["all", "todo", "upcoming", "past_due", "missing", "submitted", "graded", "excused", "no_due_date"] as const;

type AssignmentRow = {
  id: string; canvas_assignment_id: string; name: string; due_at: Stamp; unlock_at: Stamp; lock_at: Stamp; points_possible: unknown; submission_types: string[];
  canvas_course_id: string; course_name: string; status: string; submitted_at: Stamp; graded_at: Stamp; score: unknown; grade: string | null; late: boolean | null; missing: boolean | null; excused: boolean | null; description_html?: string | null; group_name?: string | null;
};
const assignmentOut = (a: AssignmentRow) => ({
  assignmentId: a.canvas_assignment_id, courseId: a.canvas_course_id, course: a.course_name, name: a.name, status: a.status,
  dueAt: iso(a.due_at), unlockAt: iso(a.unlock_at), lockAt: iso(a.lock_at), pointsPossible: num(a.points_possible), submissionTypes: a.submission_types,
  isQuiz: a.submission_types.includes("online_quiz"),
  submission: { submittedAt: iso(a.submitted_at), gradedAt: iso(a.graded_at), score: num(a.score), grade: a.grade, late: !!a.late, missing: !!a.missing, excused: !!a.excused },
});

/** One fragment so every assignment query derives status the same way. */
function assignmentsQuery(tx: Tx, ownerId: string, where: postgres.PendingQuery<postgres.Row[]>, order: postgres.PendingQuery<postgres.Row[]>, limit: number, offset: number, detail: boolean | "group" = false) {
  const withBody = detail === true;
  const withGroup = detail !== false;
  return tx<AssignmentRow[]>`select * from (
      select a.id, a.canvas_assignment_id, a.name, a.due_at, a.unlock_at, a.lock_at, a.points_possible, a.submission_types, a.course_id,
        ${withBody ? tx`a.description_html,` : tx``} ${withGroup ? tx`ag.name as group_name,` : tx``}
        c.canvas_course_id, c.name as course_name, s.submitted_at, s.graded_at, s.score, s.grade, s.late, s.missing, s.excused,
        case when s.excused then 'excused'
             when s.state = 'graded' or s.score is not null then 'graded'
             when s.submitted_at is not null or s.state in ('submitted', 'pending_review') then 'submitted'
             when s.missing then 'missing'
             when a.due_at is null then 'no_due_date'
             when a.due_at < now() then 'past_due'
             else 'upcoming' end as status
      from assignments a
      join courses c on c.owner_id = a.owner_id and c.id = a.course_id
      ${withGroup ? tx`left join assignment_groups ag on ag.owner_id = a.owner_id and ag.id = a.assignment_group_id` : tx``}
      left join lateral (select * from submissions s where s.owner_id = a.owner_id and s.assignment_id = a.id order by s.attempt desc, s.updated_at desc limit 1) s on true
      where a.owner_id = ${ownerId} and a.deleted_at is null and c.deleted_at is null and coalesce(a.workflow_state, 'published') <> 'deleted'
    ) x where true ${where} ${order} limit ${limit} offset ${offset}`;
}

const truncatedList = (key: string, items: unknown[], offset: number, extra: Data = {}) => (slice: unknown[], cut: boolean) => ({
  ...extra, count: slice.length, truncated: cut || extra.truncated === true, [key]: slice,
  ...(cut || extra.truncated === true ? { nextCursor: String(offset + slice.length) } : {}),
});

export function registerTools(server: McpServer, ownerId: string, scopes: string[] = ["canvas:read"]) {
  const run = (name: string, work: (tx: Tx) => Promise<Data>) => async (): Promise<CallToolResult> => {
    const started = Date.now();
    let status = "ok";
    try {
      const data = await withTenantSql(ownerId, async (tx) => ({ ...(await work(tx)), syncedAt: await syncedAt(tx, ownerId) }));
      return ok(data);
    } catch (error) {
      status = error instanceof ToolError ? "not_found" : "error";
      return fail(error instanceof ToolError ? error.message : "Grove could not read this data right now.");
    } finally {
      console.info(JSON.stringify({ event: "mcp_tool", tool: name, ownerId, status, ms: Date.now() - started }));
    }
  };

  server.registerTool("grove_status", {
    title: "Grove status",
    description: "Overview of the user's Canvas Grove account: connected school, timezone, how much is synced and when it last synced. Call this first if unsure what data exists.",
    inputSchema: {}, annotations: READ_ONLY,
  }, () => run("grove_status", async (tx) => {
    const [account] = await tx<{ canvas_base_url: string; timezone: string | null; status: string; last_synced_at: Stamp }[]>`select canvas_base_url, timezone, status::text as status, last_synced_at from canvas_accounts where owner_id = ${ownerId} order by last_synced_at desc nulls last limit 1`;
    const [counts] = await tx<Record<string, string>[]>`select
      (select count(*) from courses where owner_id = ${ownerId} and deleted_at is null)::text as courses,
      (select count(*) from assignments where owner_id = ${ownerId} and deleted_at is null)::text as assignments,
      (select count(*) from course_pages where owner_id = ${ownerId} and deleted_at is null)::text as pages,
      (select count(*) from course_files where owner_id = ${ownerId} and deleted_at is null)::text as files,
      (select count(*) from announcements where owner_id = ${ownerId})::text as announcements,
      (select count(*) from quizzes where owner_id = ${ownerId} and deleted_at is null)::text as quizzes`;
    const [running] = await tx<{ n: string }[]>`select count(*)::text as n from sync_jobs where owner_id = ${ownerId} and status in ('queued', 'leased', 'running')`;
    return {
      connected: !!account, canvasUrl: account?.canvas_base_url ?? null, timezone: account?.timezone ?? null, connectionStatus: account?.status ?? null,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])), syncInProgress: Number(running.n) > 0,
      capabilities: scopes.includes("canvas:write")
        ? "Reads Canvas data and can PROPOSE actions; Canvas changes wait for the user's approval in Grove unless they turned on auto mode for this connection. Supported Classic Quizzes, including graded assessments, require an approved entry-scoped attempt."
        : "Read-only connection. Quiz questions are only available inside an approved quiz session on a connection allowed to propose actions.",
    };
  })());

  server.registerTool("list_courses", {
    title: "List courses",
    description: "The user's Canvas courses with term, favorite flag and current grade. Course ids from here are used by the other tools.",
    inputSchema: { favoritesOnly: z.boolean().default(false).describe("Only courses starred in Canvas") }, annotations: READ_ONLY,
  }, ({ favoritesOnly }) => run("list_courses", async (tx) => {
    const rows = await tx<CourseRow[]>`select id, canvas_course_id, name, course_code, term_name, workflow_state, start_at, end_at, current_score, current_grade, favorite, synced_at
      from courses where owner_id = ${ownerId} and deleted_at is null ${favoritesOnly ? tx`and favorite` : tx``} order by favorite desc, start_at desc nulls last, name`;
    return fitItems(rows.map(courseOut), truncatedList("courses", rows, 0));
  })());

  server.registerTool("get_course", {
    title: "Get course",
    description: "One course: details, current grade, the syllabus as text, content counts and the next assignments due.",
    inputSchema: { course: courseRef }, annotations: READ_ONLY,
  }, ({ course }) => run("get_course", async (tx) => {
    const c = await resolveCourse(tx, ownerId, course);
    const [counts] = await tx<Record<string, string>[]>`select
      (select count(*) from assignments where owner_id = ${ownerId} and course_id = ${c.id} and deleted_at is null)::text as assignments,
      (select count(*) from course_pages where owner_id = ${ownerId} and course_id = ${c.id} and deleted_at is null)::text as pages,
      (select count(*) from course_files where owner_id = ${ownerId} and course_id = ${c.id} and deleted_at is null)::text as files,
      (select count(*) from announcements where owner_id = ${ownerId} and course_id = ${c.id})::text as announcements,
      (select count(*) from quizzes where owner_id = ${ownerId} and course_id = ${c.id} and deleted_at is null)::text as quizzes`;
    const upcoming = await assignmentsQuery(tx, ownerId, tx`and course_id = ${c.id} and status in ('upcoming', 'past_due', 'missing') and due_at > now() - interval '7 days'`, tx`order by due_at asc nulls last`, 10, 0);
    const syllabus = htmlToText(c.syllabus_body, 20_000);
    return {
      course: courseOut(c), counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
      upcoming: upcoming.map(assignmentOut),
      syllabus: syllabus.text ? untrusted(syllabus.text) : null, truncated: syllabus.truncated,
    };
  })());

  server.registerTool("list_assignments", {
    title: "List assignments",
    description: "Assignments with due dates, points and the user's submission status. Filter by course, status and a due-date window. status 'todo' = not yet submitted (upcoming, past due, missing or undated).",
    inputSchema: {
      course: courseRef.optional(),
      status: z.enum(STATUS).default("all").describe("Submission status filter"),
      dueAfter: z.string().datetime({ offset: true }).optional().describe("ISO date-time; only assignments due at or after this"),
      dueBefore: z.string().datetime({ offset: true }).optional().describe("ISO date-time; only assignments due before this"),
      limit: limitArg(200, 50), cursor: cursorArg,
    }, annotations: READ_ONLY,
  }, ({ course, status, dueAfter, dueBefore, limit, cursor }) => run("list_assignments", async (tx) => {
    const c = course ? await resolveCourse(tx, ownerId, course) : null;
    const offset = offsetOf(cursor);
    const statusFilter = status === "all" ? tx`` : status === "todo" ? tx`and status in ('upcoming', 'past_due', 'missing', 'no_due_date')` : tx`and status = ${status}`;
    const rows = await assignmentsQuery(tx, ownerId,
      tx`${c ? tx`and course_id = ${c.id}` : tx``} ${statusFilter} ${dueAfter ? tx`and due_at >= ${dueAfter}` : tx``} ${dueBefore ? tx`and due_at < ${dueBefore}` : tx``}`,
      tx`order by due_at asc nulls last, name`, limit + 1, offset);
    const more = rows.length > limit;
    return fitItems(rows.slice(0, limit).map(assignmentOut), truncatedList("assignments", rows, offset, { truncated: more }));
  })());

  server.registerTool("get_assignment", {
    title: "Get assignment",
    description: "One assignment: instructions as text, dates, points, group, the user's submission/grade, and files linked from the instructions (with a downloadPath relative to the Grove server).",
    inputSchema: { assignment: z.string().min(1).max(64).describe("Canvas assignment id (from list_assignments) or Grove's id"), course: courseRef.optional() }, annotations: READ_ONLY,
  }, ({ assignment, course }) => run("get_assignment", async (tx) => {
    const c = course ? await resolveCourse(tx, ownerId, course) : null;
    const [row] = await assignmentsQuery(tx, ownerId, tx`and (canvas_assignment_id = ${assignment} or id::text = ${assignment.toLowerCase()}) ${c ? tx`and course_id = ${c.id}` : tx``}`, tx``, 1, 0, true);
    if (!row) throw new ToolError(`No assignment "${assignment}". Use list_assignments to see assignment ids.`);
    const ids = canvasFileIdsIn(row.description_html);
    const files = ids.length ? await tx<{ canvas_file_id: string; display_name: string; content_type: string | null; size: unknown }[]>`
      select canvas_file_id, display_name, content_type, size from course_files where owner_id = ${ownerId} and deleted_at is null and canvas_file_id in ${tx(ids)}` : [];
    const body = htmlToText(row.description_html, BODY_CAP);
    return {
      assignment: { ...assignmentOut(row), group: row.group_name ?? null },
      description: body.text ? untrusted(body.text) : null, truncated: body.truncated,
      files: files.map((f) => ({ canvasFileId: f.canvas_file_id, name: f.display_name, contentType: f.content_type, size: num(f.size), downloadPath: fileDownloadPath(f.canvas_file_id) })),
    };
  })());

  server.registerTool("upcoming", {
    title: "Upcoming work",
    description: "Everything due in the next N days across all courses that is not yet submitted (set includeSubmitted to see all), soonest first.",
    inputSchema: { days: z.number().int().min(1).max(60).default(7).describe("Look-ahead window in days (default 7)"), includeSubmitted: z.boolean().default(false) }, annotations: READ_ONLY,
  }, ({ days, includeSubmitted }) => run("upcoming", async (tx) => {
    const rows = await assignmentsQuery(tx, ownerId,
      tx`and due_at >= now() and due_at < now() + ${`${days} days`}::interval ${includeSubmitted ? tx`` : tx`and status in ('upcoming', 'past_due', 'missing')`}`,
      tx`order by due_at asc`, 300, 0);
    return fitItems(rows.map(assignmentOut), truncatedList("items", rows, 0, { days, now: new Date().toISOString() }));
  })());

  server.registerTool("grades", {
    title: "Grades",
    description: "Current grade for every course, or for one course the graded assignments with scores, late/missing flags and assignment groups.",
    inputSchema: { course: courseRef.optional() }, annotations: READ_ONLY,
  }, ({ course }) => run("grades", async (tx) => {
    if (!course) {
      const rows = await tx<CourseRow[]>`select id, canvas_course_id, name, course_code, term_name, workflow_state, start_at, end_at, current_score, current_grade, favorite, synced_at
        from courses where owner_id = ${ownerId} and deleted_at is null order by favorite desc, start_at desc nulls last, name`;
      return { courses: rows.map((c) => ({ courseId: c.canvas_course_id, name: c.name, term: c.term_name, currentScore: num(c.current_score), currentGrade: c.current_grade })) };
    }
    const c = await resolveCourse(tx, ownerId, course);
    const rows = await assignmentsQuery(tx, ownerId, tx`and course_id = ${c.id} and (status in ('graded', 'excused', 'missing') or score is not null)`, tx`order by graded_at desc nulls last, due_at desc nulls last`, 500, 0, "group");
    const groups = await tx<{ name: string; group_weight: unknown; drop_lowest: number; drop_highest: number }[]>`select name, group_weight, drop_lowest, drop_highest from assignment_groups where owner_id = ${ownerId} and course_id = ${c.id} order by position nulls last, name`;
    const graded = rows.map((a) => ({ assignmentId: a.canvas_assignment_id, name: a.name, group: a.group_name ?? null, status: a.status, dueAt: iso(a.due_at), pointsPossible: num(a.points_possible), score: num(a.score), grade: a.grade, late: !!a.late, missing: !!a.missing, excused: !!a.excused, gradedAt: iso(a.graded_at) }));
    return fitItems(graded, (slice, cut) => ({
      course: { courseId: c.canvas_course_id, name: c.name, currentScore: num(c.current_score), currentGrade: c.current_grade },
      groups: groups.map((g) => ({ name: g.name, weight: num(g.group_weight), dropLowest: g.drop_lowest, dropHighest: g.drop_highest })),
      count: slice.length, truncated: cut, assignments: slice,
    }));
  })());

  server.registerTool("list_announcements", {
    title: "List announcements",
    description: "Recent course announcements, newest first, with their text.",
    inputSchema: { course: courseRef.optional(), days: z.number().int().min(1).max(365).optional().describe("Only announcements from the last N days"), limit: limitArg(50, 15) }, annotations: READ_ONLY,
  }, ({ course, days, limit }) => run("list_announcements", async (tx) => {
    const c = course ? await resolveCourse(tx, ownerId, course) : null;
    const rows = await tx<{ canvas_announcement_id: string; title: string; body_html: string | null; posted_at: Stamp; html_url: string | null; canvas_course_id: string | null; course_name: string | null }[]>`
      select a.canvas_announcement_id, a.title, a.body_html, a.posted_at, a.html_url, c.canvas_course_id, c.name as course_name
      from announcements a left join courses c on c.owner_id = a.owner_id and c.id = a.course_id
      where a.owner_id = ${ownerId} ${c ? tx`and a.course_id = ${c.id}` : tx``} ${days ? tx`and a.posted_at >= now() - ${`${days} days`}::interval` : tx``}
      order by a.posted_at desc nulls last limit ${limit}`;
    const items = rows.map((a) => ({ announcementId: a.canvas_announcement_id, courseId: a.canvas_course_id, course: a.course_name, title: a.title, postedAt: iso(a.posted_at), url: a.html_url, body: untrusted(htmlToText(a.body_html, 4_000).text) }));
    return fitItems(items, truncatedList("announcements", items, 0));
  })());

  server.registerTool("list_pages", {
    title: "List pages",
    description: "Wiki pages of one course (titles and page ids). Use get_page to read one.",
    inputSchema: { course: courseRef, limit: limitArg(300, 100), cursor: cursorArg }, annotations: READ_ONLY,
  }, ({ course, limit, cursor }) => run("list_pages", async (tx) => {
    const c = await resolveCourse(tx, ownerId, course);
    const offset = offsetOf(cursor);
    const rows = await tx<{ canvas_page_url: string; title: string; published: boolean; front_page: boolean; source_updated_at: Stamp; html_url: string | null; length: number }[]>`
      select canvas_page_url, title, published, front_page, source_updated_at, html_url, coalesce(length(body_html), 0) as length from course_pages
      where owner_id = ${ownerId} and course_id = ${c.id} and deleted_at is null order by front_page desc, title limit ${limit + 1} offset ${offset}`;
    const items = rows.slice(0, limit).map((p) => ({ page: p.canvas_page_url, title: p.title, frontPage: p.front_page, published: p.published, updatedAt: iso(p.source_updated_at), url: p.html_url, hasBody: p.length > 0 }));
    return fitItems(items, truncatedList("pages", items, offset, { courseId: c.canvas_course_id, truncated: rows.length > limit }));
  })());

  server.registerTool("get_page", {
    title: "Get page",
    description: "Read one course wiki page as text.",
    inputSchema: { course: courseRef, page: z.string().min(1).max(300).describe("Page id from list_pages (its url slug) or the exact title") }, annotations: READ_ONLY,
  }, ({ course, page }) => run("get_page", async (tx) => {
    const c = await resolveCourse(tx, ownerId, course);
    const [row] = await tx<{ canvas_page_url: string; title: string; body_html: string | null; source_updated_at: Stamp; html_url: string | null }[]>`
      select canvas_page_url, title, body_html, source_updated_at, html_url from course_pages
      where owner_id = ${ownerId} and course_id = ${c.id} and deleted_at is null and (canvas_page_url = ${page} or lower(title) = ${page.toLowerCase()})
      order by (canvas_page_url = ${page}) desc limit 1`;
    if (!row) throw new ToolError(`No page "${page}" in this course. Use list_pages to see page ids.`);
    const body = htmlToText(row.body_html, BODY_CAP);
    return { courseId: c.canvas_course_id, page: row.canvas_page_url, title: row.title, updatedAt: iso(row.source_updated_at), url: row.html_url, body: untrusted(body.text), truncated: body.truncated };
  })());

  server.registerTool("list_files", {
    title: "List files",
    description: "Course files (metadata only: name, type, size). Each item has canvasFileId and a downloadPath on the Grove server that serves the file to the same bearer token.",
    inputSchema: { course: courseRef.optional(), query: z.string().min(1).max(100).optional().describe("Filter by file name (substring)"), limit: limitArg(200, 50), cursor: cursorArg }, annotations: READ_ONLY,
  }, ({ course, query, limit, cursor }) => run("list_files", async (tx) => {
    const c = course ? await resolveCourse(tx, ownerId, course) : null;
    const offset = offsetOf(cursor);
    const rows = await tx<{ canvas_file_id: string; display_name: string; filename: string | null; content_type: string | null; size: unknown; locked: boolean; source_updated_at: Stamp; canvas_course_id: string; course_name: string }[]>`
      select f.canvas_file_id, f.display_name, f.filename, f.content_type, f.size, f.locked, f.source_updated_at, c.canvas_course_id, c.name as course_name
      from course_files f join courses c on c.owner_id = f.owner_id and c.id = f.course_id
      where f.owner_id = ${ownerId} and f.deleted_at is null and c.deleted_at is null ${c ? tx`and f.course_id = ${c.id}` : tx``}
        ${query ? tx`and f.display_name ilike ${likePattern(query)}` : tx``}
      order by f.source_updated_at desc nulls last, f.display_name limit ${limit + 1} offset ${offset}`;
    const items = rows.slice(0, limit).map((f) => ({ canvasFileId: f.canvas_file_id, courseId: f.canvas_course_id, course: f.course_name, name: f.display_name, filename: f.filename, contentType: f.content_type, size: num(f.size), locked: f.locked, updatedAt: iso(f.source_updated_at), downloadPath: fileDownloadPath(f.canvas_file_id) }));
    return fitItems(items, truncatedList("files", items, offset, { truncated: rows.length > limit }));
  })());

  server.registerTool("list_quizzes", {
    title: "List quizzes",
    description: "Quiz metadata only (title, due dates, points, question count, time limit, attempts). Never returns quiz questions or answers.",
    inputSchema: { course: courseRef.optional(), limit: limitArg(200, 50) }, annotations: READ_ONLY,
  }, ({ course, limit }) => run("list_quizzes", async (tx) => {
    const c = course ? await resolveCourse(tx, ownerId, course) : null;
    const rows = await tx<{ canvas_quiz_id: string; title: string; engine: string; quiz_type: string | null; points_possible: unknown; question_count: number | null; time_limit_minutes: number | null; allowed_attempts: number | null; due_at: Stamp; unlock_at: Stamp; lock_at: Stamp; published: boolean; locked_for_user: boolean; html_url: string | null; canvas_course_id: string; course_name: string; supported: boolean; description_html: string | null; source_payload: unknown }[]>`
      select q.canvas_quiz_id, q.title, q.engine, q.quiz_type, q.supported, q.description_html, q.source_payload, q.points_possible, q.question_count, q.time_limit_minutes, q.allowed_attempts, q.due_at, q.unlock_at, q.lock_at, q.published, q.locked_for_user, q.html_url, c.canvas_course_id, c.name as course_name
      from quizzes q join courses c on c.owner_id = q.owner_id and c.id = q.course_id
      where q.owner_id = ${ownerId} and q.deleted_at is null and c.deleted_at is null ${c ? tx`and q.course_id = ${c.id}` : tx``}
      order by q.due_at asc nulls last, q.title limit ${limit}`;
    const items = rows.map((q) => ({ quizId: q.canvas_quiz_id, courseId: q.canvas_course_id, course: q.course_name, title: q.title, engine: q.engine, type: q.quiz_type, ...quizClassification(q.quiz_type), pointsPossible: num(q.points_possible), questionCount: q.question_count, timeLimitMinutes: q.time_limit_minutes, allowedAttempts: q.allowed_attempts, dueAt: iso(q.due_at), unlockAt: iso(q.unlock_at), lockAt: iso(q.lock_at), published: q.published, locked: q.locked_for_user, url: q.html_url, ...eligibilityOut(q) }));
    return fitItems(items, truncatedList("quizzes", items, 0));
  })());

  server.registerTool("search", {
    title: "Search",
    description: "Search course names, assignments (titles and instructions), pages (titles and bodies) and file names across all courses.",
    inputSchema: { query: z.string().min(2).max(100), limit: limitArg(50, 20) }, annotations: READ_ONLY,
  }, ({ query, limit }) => run("search", async (tx) => {
    const like = likePattern(query);
    const snippet = (html: string | null) => {
      const text = htmlToText(html, 200_000).text.replace(/\s+/g, " ");
      const at = text.toLowerCase().indexOf(query.toLowerCase());
      if (at < 0) return null;
      return untrusted(`${at > 80 ? "…" : ""}${text.slice(Math.max(0, at - 80), at + query.length + 120)}…`);
    };
    const courses = await tx<{ canvas_course_id: string; name: string; course_code: string | null }[]>`select canvas_course_id, name, course_code from courses where owner_id = ${ownerId} and deleted_at is null and (name ilike ${like} or course_code ilike ${like}) limit ${limit}`;
    const assignments = await tx<{ canvas_assignment_id: string; name: string; due_at: Stamp; description_html: string | null; canvas_course_id: string; course_name: string }[]>`
      select a.canvas_assignment_id, a.name, a.due_at, a.description_html, c.canvas_course_id, c.name as course_name from assignments a join courses c on c.owner_id = a.owner_id and c.id = a.course_id
      where a.owner_id = ${ownerId} and a.deleted_at is null and c.deleted_at is null and (a.name ilike ${like} or a.description_html ilike ${like}) order by (a.name ilike ${like}) desc, a.due_at desc nulls last limit ${limit}`;
    const pages = await tx<{ canvas_page_url: string; title: string; body_html: string | null; canvas_course_id: string; course_name: string }[]>`
      select p.canvas_page_url, p.title, p.body_html, c.canvas_course_id, c.name as course_name from course_pages p join courses c on c.owner_id = p.owner_id and c.id = p.course_id
      where p.owner_id = ${ownerId} and p.deleted_at is null and c.deleted_at is null and (p.title ilike ${like} or p.body_html ilike ${like}) order by (p.title ilike ${like}) desc, p.title limit ${limit}`;
    const files = await tx<{ canvas_file_id: string; display_name: string; content_type: string | null; canvas_course_id: string; course_name: string }[]>`
      select f.canvas_file_id, f.display_name, f.content_type, c.canvas_course_id, c.name as course_name from course_files f join courses c on c.owner_id = f.owner_id and c.id = f.course_id
      where f.owner_id = ${ownerId} and f.deleted_at is null and c.deleted_at is null and f.display_name ilike ${like} order by f.display_name limit ${limit}`;
    const results = [
      ...courses.map((c) => ({ type: "course", courseId: c.canvas_course_id, title: c.name, code: c.course_code })),
      ...assignments.map((a) => ({ type: "assignment", assignmentId: a.canvas_assignment_id, courseId: a.canvas_course_id, course: a.course_name, title: a.name, dueAt: iso(a.due_at), match: snippet(a.description_html) })),
      ...pages.map((p) => ({ type: "page", page: p.canvas_page_url, courseId: p.canvas_course_id, course: p.course_name, title: p.title, match: snippet(p.body_html) })),
      ...files.map((f) => ({ type: "file", canvasFileId: f.canvas_file_id, courseId: f.canvas_course_id, course: f.course_name, title: f.display_name, contentType: f.content_type, downloadPath: fileDownloadPath(f.canvas_file_id) })),
    ];
    return fitItems(results, truncatedList("results", results, 0, { query }));
  })());
}

/** Eligibility flag for list_quizzes (metadata only; the gate itself runs on every quiz call). */
function eligibilityOut(q: { engine: string; quiz_type: string | null; points_possible: unknown; supported: boolean; title: string; description_html: string | null; source_payload: unknown }) {
  const e = quizEligibility(q);
  return e.eligible ? { eligibleForAssistant: true } : { eligibleForAssistant: false, ineligibleReason: e.reason };
}

export const TOOL_NAMES = ["grove_status", "list_courses", "get_course", "list_assignments", "get_assignment", "upcoming", "grades", "list_announcements", "list_pages", "get_page", "list_files", "list_quizzes", "search"] as const;
