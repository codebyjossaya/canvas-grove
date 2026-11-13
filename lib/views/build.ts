import { addDays, dayKey, daySublabel, dayLabel, diffDays, formatKey, iso, ms, weekRangeLabel, weekStartKey } from "./dates";
import { assignmentHref } from "./assignment-detail-core";
import { htmlToParagraphs, initials, plainText, safeHttpsUrl } from "./text";
import type {
  AnnouncementRow, AssignmentRow, CourseCard, CourseRef, CourseRow, CoursesView, DayGroup, DigestEntry,
  GradesOverviewCourse, InboxAnnouncement, InboxMessage, InboxThread, InboxView, MessageRow, PaletteIndex, PlannerRow,
  PlannerView, RecentGrade, SidebarCourse, SubmissionRow, TodayView, WorkItem, WorkKind, WorkloadDay, WorkState, WorkspaceRows,
} from "./types";

// Pure view builders. Every surface is derived only from synced Canvas rows; nothing here
// invents data. Server loaders (lib/views/loaders.ts) and the dev fixture preview both call
// these, so what the preview shows is exactly what signed-in students see.

export const COURSE_COLORS = 8;
const OVERDUE_WINDOW_DAYS = 21;

export function courseColor(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % COURSE_COLORS;
}

export function num(value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function courseRef(course: Pick<CourseRow, "id" | "name" | "courseCode">): CourseRef {
  return { id: course.id, name: course.name, code: shortCode(course.courseCode, course.name), color: courseColor(course.id) };
}

function shortCode(code: string | null, name: string) {
  const value = (code ?? "").trim();
  if (value && value.length <= 14) return value;
  const match = value.match(/[A-Z]{2,4}\s?-?\d{3,4}[A-Z]?/);
  if (match) return match[0];
  return value ? value.slice(0, 12) : initials(name);
}

export function courseDisplayGrade(course: Pick<CourseRow, "currentGrade" | "currentScore">) {
  return { grade: course.currentGrade?.trim() || null, score: num(course.currentScore) };
}

function courseMap(rows: CourseRow[]) { return new Map(rows.map(row => [row.id, row])); }

function latestSubmissions(rows: SubmissionRow[]) {
  const map = new Map<string, SubmissionRow>();
  for (const row of rows) { const current = map.get(row.assignmentId); if (!current || row.attempt > current.attempt) map.set(row.assignmentId, row); }
  return map;
}

function assignmentKind(types: string[]): WorkKind {
  if (types.includes("online_quiz")) return "quiz";
  if (types.includes("discussion_topic")) return "discussion";
  return "assignment";
}

function plannerKind(row: PlannerRow): WorkKind {
  const value = `${row.canvasItemType ?? ""} ${row.kind}`.toLowerCase();
  if (value.includes("quiz")) return "quiz";
  if (value.includes("discussion")) return "discussion";
  if (value.includes("event") || value.includes("calendar")) return "event";
  if (value.includes("note") || row.source === "app") return "note";
  if (value.includes("page") || value.includes("wiki")) return "page";
  if (value.includes("assignment")) return "assignment";
  return "other";
}

const NOT_SUBMITTABLE = new Set(["none", "on_paper", "not_graded", "external_tool_none"]);

export function submissionState(submission: SubmissionRow | undefined, dueAt: string | null, nowMs: number, submissionTypes: string[] = []): WorkState {
  if (submission?.excused) return "excused";
  if (submission?.missing) return "missing";
  const graded = submission && (submission.state === "graded" || (submission.gradedAt && num(submission.score) != null));
  if (graded) return "graded";
  if (submission && (submission.submittedAt || submission.state === "submitted" || submission.state === "pending_review")) return submission.late ? "late" : "submitted";
  const past = Boolean(dueAt && new Date(dueAt).getTime() < nowMs);
  if (submissionTypes.length > 0 && submissionTypes.every(type => NOT_SUBMITTABLE.has(type))) return past ? "past" : "open";
  return past ? "overdue" : "open";
}

export function isDone(state: WorkState) { return state === "submitted" || state === "graded" || state === "excused" || state === "done" || state === "late" || state === "past"; }

function canvasUrl(origin: string | null, path: string) {
  if (!origin) return null;
  try { return safeHttpsUrl(new URL(path, origin).toString()); } catch { return null; }
}

/** Canvas planner item types mapped to the identity namespace used for assignments. */
const PLANNER_IDENTITY: Record<string, string> = { assignment: "assignment", quiz: "quiz", discussion_topic: "discussion", calendar_event: "event", wiki_page: "page", announcement: "announcement" };

function normTitle(value: string) { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
function normUrl(value: string | null | undefined) {
  const url = safeHttpsUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
}

/**
 * Stable identities for one Canvas object. The same item reaches us through several feeds:
 * the assignments API, the calendar-events API (events and type=assignment rows mirrored into
 * assignments), and planner items for quizzes, discussions, events and assignments.
 */
function assignmentIdentities(row: AssignmentRow, isEvent: boolean): string[] {
  const scope = row.courseId, keys = [`row:${row.id}`, `${scope}|${isEvent ? "event" : "assignment"}:${row.canvasAssignmentId}`];
  if (row.quizId) keys.push(`${scope}|quiz:${row.quizId}`);
  if (row.discussionTopicId) keys.push(`${scope}|discussion:${row.discussionTopicId}`);
  const url = normUrl(row.htmlUrl); if (url) keys.push(`url:${url}`);
  return keys;
}

/** Same course, same title, same due instant: the student cannot tell these apart (per-section copies, quiz + its assignment, ...). */
function contentIdentity(courseId: string | null, title: string, dueAt: string | null) {
  return `${courseId ?? "-"}|t:${normTitle(title)}|${dueAt ?? "-"}`;
}

/** Higher wins when two records describe the same Canvas item. */
function richness(item: WorkItem, fromAssignment: boolean) {
  return (fromAssignment ? 16 : 0) + (["graded", "submitted", "late", "excused", "missing"].includes(item.state) ? 8 : 0) + (item.points != null ? 4 : 0) + (item.canvasUrl ? 2 : 0) + (item.dueAt ? 1 : 0);
}

/**
 * Whether Canvas still accepts a submission. An item is closed when its lock date has passed,
 * Canvas reported it locked for this student after the due date, it sits in a closed grading
 * period, or it takes no online submission at all. Past-due work with none of these signals is
 * still submittable late in Canvas, so it stays visible.
 */
export function isClosedForSubmission(row: Pick<AssignmentRow, "lockAt" | "unlockAt" | "lockedForUser" | "inClosedGradingPeriod" | "submissionTypes" | "dueAt">, nowMs: number) {
  const lock = ms(row.lockAt), unlock = ms(row.unlockAt), due = ms(row.dueAt);
  if (lock != null && lock <= nowMs) return true;
  if (row.inClosedGradingPeriod === true) return true;
  if (row.submissionTypes.length > 0 && row.submissionTypes.every(type => NOT_SUBMITTABLE.has(type))) return true;
  // locked_for_user is a sync-time snapshot; trust it only once the due date has passed and the item is not merely "not yet unlocked".
  if (row.lockedForUser === true && due != null && due < nowMs && (unlock == null || unlock <= nowMs)) return true;
  return false;
}

/** One list of dated work: assignments (with their submission state) plus planner-only items, de-duplicated by Canvas identity. */
export function buildWorkItems(rows: WorkspaceRows, now: Date): WorkItem[] {
  const courses = courseMap(rows.courses), submissions = latestSubmissions(rows.submissions), nowMs = now.getTime();
  const slots: Array<{ item: WorkItem; rank: number }> = [];
  const byKey = new Map<string, number>();
  const place = (item: WorkItem, keys: string[], fromAssignment: boolean, plannerCompleted = false) => {
    const rank = richness(item, fromAssignment);
    const hit = keys.map(key => byKey.get(key)).find(index => index != null);
    if (hit == null) { const index = slots.push({ item, rank }) - 1; for (const key of keys) byKey.set(key, index); return; }
    const current = slots[hit];
    let winner = rank > current.rank ? { item, rank } : current;
    // A Canvas planner "done" checkmark on a duplicate still marks the surviving record done.
    if (plannerCompleted && (winner.item.state === "open" || winner.item.state === "overdue")) winner = { ...winner, item: { ...winner.item, state: "done" } };
    slots[hit] = winner;
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, hit);
  };
  for (const row of rows.assignments) {
    const course = courses.get(row.courseId);
    if (!course || row.workflowState === "unpublished" || row.workflowState === "deleted") continue;
    const dueAt = iso(row.dueAt), submission = submissions.get(row.id), isEvent = row.sourceType === "event";
    const htmlUrl = safeHttpsUrl(row.htmlUrl);
    const item: WorkItem = isEvent ? {
      id: row.id, kind: "event", title: row.name, course: courseRef(course), dueAt, allDay: false, points: null,
      state: dueAt && new Date(dueAt).getTime() < nowMs ? "past" : "open", score: null, href: `/courses/${course.id}`, canvasUrl: htmlUrl, closed: false,
    } : {
      id: row.id, kind: assignmentKind(row.submissionTypes), title: row.name, course: courseRef(course), dueAt, allDay: false,
      points: num(row.pointsPossible), state: submissionState(submission, dueAt, nowMs, row.submissionTypes), score: num(submission?.score),
      href: assignmentHref(course.id, row.id), canvasUrl: htmlUrl ?? canvasUrl(rows.canvasOrigin, `/courses/${course.canvasCourseId}/assignments/${row.canvasAssignmentId}`),
      closed: isClosedForSubmission(row, nowMs),
    };
    place(item, [...assignmentIdentities(row, isEvent), contentIdentity(row.courseId, row.name, dueAt)], true);
  }
  for (const row of rows.planner) {
    if (row.status === "cancelled") continue;
    const course = row.courseId ? courses.get(row.courseId) ?? null : null;
    const dueAt = iso(row.dueAt ?? row.startsAt);
    const keys = [`planner:${row.id}`];
    if (row.assignmentId) keys.push(`row:${row.assignmentId}`);
    const namespace = row.canvasItemType ? PLANNER_IDENTITY[row.canvasItemType] : undefined;
    if (namespace && row.canvasItemId && row.courseId) keys.push(`${row.courseId}|${namespace}:${row.canvasItemId}`);
    if (row.source === "canvas") keys.push(contentIdentity(row.courseId, row.title, dueAt));
    place({
      id: row.id, kind: plannerKind(row), title: row.title, course: course ? courseRef(course) : null, dueAt, allDay: false, points: null,
      state: row.status === "completed" ? "done" : dueAt && new Date(dueAt).getTime() < nowMs ? "past" : "open", score: null, href: course ? `/courses/${course.id}` : "/planner", canvasUrl: null,
    }, keys, false, row.status === "completed");
  }
  return slots.map(slot => slot.item).sort(byDue);
}

function byDue(a: WorkItem, b: WorkItem) {
  return (ms(a.dueAt) ?? Number.MAX_SAFE_INTEGER) - (ms(b.dueAt) ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title);
}

function groupByDay(items: WorkItem[], zone: string, todayKey: string): DayGroup[] {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) { const key = dayKey(item.dueAt, zone); if (!key) continue; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ key, label: dayLabel(key, todayKey), sublabel: daySublabel(key), items: list }));
}

export type DigestInput = { since: Date | null; messages?: MessageRow[] };

export function buildToday(rows: WorkspaceRows, now: Date, zone: string, digest: DigestInput, greetingName: string | null = null): TodayView {
  const nowIso = now.toISOString(), nowMs = now.getTime(), todayKey = dayKey(nowIso, zone);
  const items = buildWorkItems(rows, now).filter(item => item.dueAt);
  const overdue: WorkItem[] = [], today: WorkItem[] = [], week: WorkItem[] = [];
  let laterCount = 0;
  for (const item of items) {
    const due = ms(item.dueAt)!, key = dayKey(item.dueAt, zone), delta = diffDays(key, todayKey);
    // Past-due work is surfaced only while Canvas still accepts it (see isClosedForSubmission).
    if (due < nowMs && !isDone(item.state)) { if (!item.closed && nowMs - due <= OVERDUE_WINDOW_DAYS * 86_400_000) overdue.push(item); continue; }
    if (delta === 0) today.push(item);
    else if (delta > 0 && delta <= 7) week.push(item);
    else if (delta > 7 && !isDone(item.state)) laterCount++;
  }
  const courses = rows.courses.filter(course => course.favorite).map(course => {
    const { grade, score } = courseDisplayGrade(course);
    return { ...courseRef(course), grade, score, dueThisWeek: [...today, ...week].filter(item => item.course?.id === course.id && !isDone(item.state)).length };
  });
  return {
    now: nowIso, zone, greetingName,
    overdue: overdue.sort(byDue), today, week: groupByDay(week, zone, todayKey), laterCount,
    digest: buildDigest(rows, now, zone, digest),
    courses,
    hasAnyData: rows.courses.length + rows.assignments.length + rows.announcements.length + rows.conversations.length > 0,
  };
}

function buildDigest(rows: WorkspaceRows, now: Date, zone: string, input: DigestInput): TodayView["digest"] {
  const firstVisit = !input.since;
  const since = input.since ?? new Date(now.getTime() - 3 * 86_400_000);
  const sinceMs = since.getTime(), courses = courseMap(rows.courses);
  const ref = (id: string | null) => { const course = id ? courses.get(id) : null; return course ? courseRef(course) : null; };
  const entries: DigestEntry[] = [];
  for (const row of rows.announcements) {
    const at = iso(row.postedAt);
    if (at && ms(at)! > sinceMs) entries.push({ kind: "announcement", id: row.id, title: row.title, course: ref(row.courseId), at, href: `/inbox?tab=announcements&a=${row.id}` });
  }
  for (const row of rows.conversations) {
    const at = iso(row.lastMessageAt);
    if (at && ms(at)! > sinceMs) entries.push({ kind: "message", id: row.id, title: row.subject?.trim() || "(No subject)", from: participantNames(row.participants), course: ref(row.courseId), at, href: `/inbox?c=${row.id}`, unread: row.workflowState === "unread" });
  }
  const assignments = new Map(rows.assignments.map(row => [row.id, row]));
  for (const submission of latestSubmissions(rows.submissions).values()) {
    const at = iso(submission.gradedAt), assignment = assignments.get(submission.assignmentId);
    if (!at || !assignment || ms(at)! <= sinceMs || (num(submission.score) == null && !submission.grade)) continue;
    entries.push({ kind: "grade", id: submission.assignmentId, title: assignment.name, course: ref(assignment.courseId), at, href: `/courses/${assignment.courseId}/grades`, score: num(submission.score), points: num(assignment.pointsPossible), grade: submission.grade });
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const sinceIso = since.toISOString();
  return { since: sinceIso, sinceLabel: firstVisit ? "in the last 3 days" : `since ${sinceLabelFor(sinceIso, now, zone)}`, firstVisit, entries: entries.slice(0, 12) };
}

function sinceLabelFor(sinceIso: string, now: Date, zone: string) {
  const delta = diffDays(dayKey(now, zone), dayKey(sinceIso, zone));
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(sinceIso));
  if (delta === 0) return `${time} today`;
  if (delta === 1) return `yesterday, ${time}`;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(new Date(sinceIso));
}

export function participantNames(value: unknown, limit = 3) {
  const rows = Array.isArray(value) ? value : [];
  const names = rows.map(item => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name.trim() : "").filter(Boolean);
  if (!names.length) return "Canvas";
  return names.length > limit ? `${names.slice(0, limit).join(", ")} +${names.length - limit}` : names.join(", ");
}

export function buildPlanner(rows: WorkspaceRows, now: Date, zone: string, options: { weekStart?: string | null; view?: string | null; weekStartsOn?: number }): PlannerView {
  const nowIso = now.toISOString(), todayKey = dayKey(nowIso, zone), weekStartsOn = options.weekStartsOn ?? 0;
  const thisWeek = weekStartKey(todayKey, weekStartsOn);
  const weekStart = options.weekStart ? weekStartKey(options.weekStart, weekStartsOn) : thisWeek;
  const all = buildWorkItems(rows, now);
  const dated = all.filter(item => item.dueAt), undated = all.filter(item => !item.dueAt && !isDone(item.state)).slice(0, 20);
  const byKey = new Map<string, WorkItem[]>();
  for (const item of dated) { const key = dayKey(item.dueAt, zone); byKey.set(key, [...(byKey.get(key) ?? []), item]); }
  const days = Array.from({ length: 7 }, (_, index) => {
    const key = addDays(weekStart, index);
    return { key, label: dayLabel(key, todayKey), sublabel: daySublabel(key), items: byKey.get(key) ?? [], today: key === todayKey, weekday: formatKey(key, { weekday: "short" }), dayNumber: formatKey(key, { day: "numeric" }) };
  });
  const agendaStart = weekStart === thisWeek ? todayKey : weekStart;
  const agenda: DayGroup[] = [];
  for (let index = 0; index < 28; index++) {
    const key = addDays(agendaStart, index), list = byKey.get(key);
    if (list?.length) agenda.push({ key, label: dayLabel(key, todayKey), sublabel: daySublabel(key), items: list });
  }
  const workload: WorkloadDay[] = Array.from({ length: 14 }, (_, index) => {
    const key = addDays(todayKey, index), open = (byKey.get(key) ?? []).filter(item => !isDone(item.state));
    return { key, weekday: formatKey(key, { weekday: "narrow" }), day: formatKey(key, { day: "numeric" }), count: open.length, points: open.reduce((sum, item) => sum + (item.points ?? 0), 0), today: index === 0 };
  });
  const weekLabel = weekRangeLabel(weekStart);
  return {
    now: nowIso, zone, view: options.view === "agenda" ? "agenda" : "week", weekStart, weekLabel,
    prevWeek: addDays(weekStart, -7), nextWeek: addDays(weekStart, 7), thisWeek, isCurrentWeek: weekStart === thisWeek,
    days, agenda, undated, workload, hasAnyData: all.length > 0,
  };
}

export function buildInbox(rows: WorkspaceRows, messages: MessageRow[], options: { tab?: string | null; thread?: string | null; announcement?: string | null }, zone: string): InboxView {
  const courses = courseMap(rows.courses);
  const ref = (id: string | null) => { const course = id ? courses.get(id) : null; return course ? courseRef(course) : null; };
  const byThread = new Map<string, MessageRow[]>();
  for (const message of messages) byThread.set(message.conversationId, [...(byThread.get(message.conversationId) ?? []), message]);
  const threads: InboxThread[] = [...rows.conversations].sort((a, b) => (ms(b.lastMessageAt) ?? 0) - (ms(a.lastMessageAt) ?? 0)).map(row => {
    const list = (byThread.get(row.id) ?? []).sort((a, b) => (ms(b.sentAt) ?? 0) - (ms(a.sentAt) ?? 0));
    const names = participantNames(row.participants);
    return { id: row.id, subject: row.subject?.trim() || "(No subject)", participants: names, initials: initials(list[0]?.authorName ?? names), course: ref(row.courseId),
      lastAt: iso(row.lastMessageAt), count: Math.max(row.messageCount, list.length), unread: row.workflowState === "unread", starred: row.starred, preview: plainText(list[0]?.bodyHtml, 160) };
  });
  const announcements: InboxAnnouncement[] = [...rows.announcements].sort((a, b) => (ms(b.postedAt) ?? 0) - (ms(a.postedAt) ?? 0)).map((row: AnnouncementRow) => ({
    id: row.id, title: row.title, course: ref(row.courseId), at: iso(row.postedAt), preview: plainText(row.bodyHtml, 160), paragraphs: htmlToParagraphs(row.bodyHtml), canvasUrl: safeHttpsUrl(row.htmlUrl),
  }));
  const tab = options.tab === "announcements" ? "announcements" : "messages";
  const thread = threads.find(item => item.id === options.thread) ?? null;
  const selectedThread = thread ? { ...thread, messages: (byThread.get(thread.id) ?? []).sort((a, b) => (ms(a.sentAt) ?? 0) - (ms(b.sentAt) ?? 0)).map(messageModel) } : null;
  return { zone, tab, canvasInboxUrl: canvasUrl(rows.canvasOrigin, "/conversations"), threads, announcements, selectedThread, selectedAnnouncement: announcements.find(item => item.id === options.announcement) ?? null };
}

function messageModel(row: MessageRow): InboxMessage {
  const attachments = (Array.isArray(row.attachments) ? row.attachments : []).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const name = typeof value.display_name === "string" ? value.display_name : typeof value.filename === "string" ? value.filename : typeof value.name === "string" ? value.name : null;
    return name ? [{ name, url: safeHttpsUrl(value.url) }] : [];
  });
  const author = row.authorName?.trim() || "Canvas user";
  return { id: row.id, author, initials: initials(author), at: iso(row.sentAt), paragraphs: htmlToParagraphs(row.bodyHtml), attachments };
}

export function buildCourses(rows: WorkspaceRows, now: Date, zone: string, view: string | null | undefined): CoursesView {
  const items = buildWorkItems(rows, now), nowMs = now.getTime(), weekEnd = nowMs + 7 * 86_400_000;
  const cards: CourseCard[] = rows.courses.map(course => {
    const own = items.filter(item => item.course?.id === course.id);
    const upcoming = own.filter(item => item.dueAt && ms(item.dueAt)! >= nowMs && !isDone(item.state));
    const { grade, score } = courseDisplayGrade(course);
    return { ...courseRef(course), term: course.termName, grade, score, favorite: course.favorite, next: upcoming[0] ?? null,
      dueThisWeek: upcoming.filter(item => ms(item.dueAt)! <= weekEnd).length, missing: own.filter(item => item.state === "missing" || item.state === "overdue").length };
  });
  return { view: view === "inactive" ? "inactive" : "active", active: cards.filter(card => card.favorite), inactive: cards.filter(card => !card.favorite), zone, now: now.toISOString() };
}

export function buildGradesOverview(rows: WorkspaceRows): { courses: GradesOverviewCourse[]; recent: RecentGrade[] } {
  const latest = latestSubmissions(rows.submissions), assignments = new Map(rows.assignments.map(row => [row.id, row])), courses = courseMap(rows.courses);
  const stats = new Map<string, { graded: number; missing: number }>();
  for (const submission of latest.values()) {
    const assignment = assignments.get(submission.assignmentId); if (!assignment) continue;
    const entry = stats.get(assignment.courseId) ?? { graded: 0, missing: 0 };
    if (num(submission.score) != null) entry.graded++;
    if (submission.missing) entry.missing++;
    stats.set(assignment.courseId, entry);
  }
  const list = rows.courses.map(course => ({ ...courseRef(course), term: course.termName, ...courseDisplayGrade(course), favorite: course.favorite, graded: stats.get(course.id)?.graded ?? 0, missing: stats.get(course.id)?.missing ?? 0 }))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  const recent: RecentGrade[] = [...latest.values()].flatMap(submission => {
    const assignment = assignments.get(submission.assignmentId), course = assignment ? courses.get(assignment.courseId) : null, gradedAt = iso(submission.gradedAt);
    if (!assignment || !course || !gradedAt || (num(submission.score) == null && !submission.grade)) return [];
    return [{ id: assignment.id, title: assignment.name, course: courseRef(course), gradedAt, score: num(submission.score), points: num(assignment.pointsPossible), grade: submission.grade }];
  }).sort((a, b) => b.gradedAt.localeCompare(a.gradedAt)).slice(0, 8);
  return { courses: list, recent };
}

export function buildPaletteIndex(rows: WorkspaceRows, now: Date): PaletteIndex {
  const nowMs = now.getTime();
  const items = buildWorkItems(rows, now).filter(item => {
    const due = ms(item.dueAt);
    if (due == null) return !isDone(item.state);
    return due >= nowMs - OVERDUE_WINDOW_DAYS * 86_400_000 && due <= nowMs + 60 * 86_400_000;
  }).slice(0, 250).map(item => ({ id: item.id, title: item.title, course: item.course, dueAt: item.dueAt, href: item.href, canvasUrl: item.canvasUrl, state: item.state }));
  const courses = rows.courses.map(course => ({ ...courseRef(course), favorite: course.favorite })).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  return { courses, items };
}

export function buildSidebarCourses(rows: CourseRow[]): SidebarCourse[] {
  return rows.filter(course => course.favorite).map(course => ({ ...courseRef(course), favorite: true })).sort((a, b) => a.code.localeCompare(b.code));
}

export type { PlannerRow };
