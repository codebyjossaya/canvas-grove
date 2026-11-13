import { calculateGrade } from "@/lib/grades/engine";
import { buildPaletteIndex, buildWorkItems, courseRef, num } from "@/lib/views/build";
import type { QuizSummary } from "@/components/ui/quiz-types";
import { COURSE_IDS, FIXTURE_ORIGIN, FIXTURE_ZONE, fixtureGroups, fixtureRows } from "./fixture-rows";

// DEV-ONLY: JSON responses for the client-fetched endpoints, used by the /dev-preview fetch
// shim. Shapes mirror the real route handlers in app/api/**.

type Json = Record<string, unknown>;
export type FixtureResponse = { status: number; body: unknown };

const ok = (body: unknown): FixtureResponse => ({ status: 200, body });
const minutesAgo = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

function courseOf(id: string, now: Date) {
  const rows = fixtureRows(now);
  const course = rows.courses.find(item => item.id === id);
  return course ? { rows, course } : null;
}

function tabs(courseId: string, canvasCourseId: string) {
  const native = [["home", "Home", "overview"], ["announcements", "Announcements", "announcements"], ["assignments", "Assignments", "assignments"], ["modules", "Modules", "modules"], ["pages", "Pages", "pages"], ["files", "Files", "files"], ["syllabus", "Syllabus", "syllabus"], ["grades", "Grades", "grades"]];
  return [
    ...native.map(([id, label, section], index) => ({ id, label, position: index + 1, hidden: false, type: "native", nativePath: `/courses/${courseId}/${section}`, canvasUrl: `${FIXTURE_ORIGIN}/courses/${canvasCourseId}/${id}` })),
    { id: "context_external_tool_42", label: "Panopto Recordings", position: 9, hidden: false, type: "external", nativePath: null, canvasUrl: `${FIXTURE_ORIGIN}/courses/${canvasCourseId}/external_tools/42` },
    { id: "context_external_tool_77", label: "Pearson MyLab", position: 10, hidden: false, type: "external", nativePath: null, canvasUrl: `${FIXTURE_ORIGIN}/courses/${canvasCourseId}/external_tools/77` },
  ];
}

function courseModel(course: { id: string; name: string; courseCode: string | null; canvasCourseId: string; currentScore: string | number | null; currentGrade: string | null }) {
  return { id: course.id, name: course.name, courseCode: course.courseCode, canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}`, currentScore: num(course.currentScore), currentGrade: course.currentGrade };
}

function section(courseId: string, name: string, now: Date): FixtureResponse {
  const found = courseOf(courseId, now);
  if (!found) return { status: 404, body: { error: "Course not found", code: "COURSE_NOT_FOUND" } };
  const { rows, course } = found;
  const items = buildWorkItems(rows, now).filter(item => item.course?.id === courseId);
  const assignments = rows.assignments.filter(item => item.courseId === courseId);
  const announcements = rows.announcements.filter(item => item.courseId === courseId);
  const base = { course: courseModel(course), section: name, lastSyncedAt: minutesAgo(now, 7), stale: false };
  if (name === "overview") {
    const upcoming = items.filter(item => item.dueAt && new Date(item.dueAt).getTime() >= now.getTime() - 86_400_000).slice(0, 8);
    return ok({ ...base, data: { upcoming, overdue: items.filter(item => item.state === "overdue" || item.state === "missing"), announcements: announcements.slice(0, 4) } });
  }
  if (name === "assignments") return ok({ ...base, data: { items: items.filter(item => assignments.some(row => row.id === item.id)) } });
  if (name === "announcements") return ok({ ...base, data: { announcements } });
  if (name === "files") {
    const folders = [{ id: "f1", name: "Lectures", fullName: "course files/Lectures", filesCount: 9, foldersCount: 0 }, { id: "f2", name: "Readings", fullName: "course files/Readings", filesCount: 6, foldersCount: 0 }, { id: "f3", name: "Exams", fullName: "course files/Exams", filesCount: 2, foldersCount: 0 }];
    const names = [["Lecture 01 – Course overview.pdf", "f1", "application/pdf", 1_820_000], ["Lecture 02 – Market segmentation.pdf", "f1", "application/pdf", 2_410_000], ["Lecture 03 – Positioning.pptx", "f1", "application/vnd.ms-powerpoint", 6_300_000], ["Lecture 04 – Consumer behavior.pdf", "f1", "application/pdf", 1_210_000], ["Lecture 05 – Pricing strategy.pdf", "f1", "application/pdf", 1_950_000], ["Reading – Kotler ch. 9.pdf", "f2", "application/pdf", 3_200_000], ["Reading – HBR Patagonia case.pdf", "f2", "application/pdf", 880_000], ["Practice exam 2.pdf", "f3", "application/pdf", 420_000], ["Formula sheet template.docx", "f3", "application/msword", 64_000], ["Project rubric.xlsx", "f2", "application/vnd.ms-excel", 31_000]] as const;
    return ok({ ...base, data: { folders, files: names.map(([displayName, folderId, contentType, size], index) => ({ id: `file-${index}`, folderId, displayName, contentType, size, updatedAt: minutesAgo(now, 60 * 24 * (index + 2)), downloadPath: `/api/canvas/courses/${courseId}/files/file-${index}/download`, canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}/files/${3000 + index}` })) } });
  }
  if (name === "syllabus") return ok({ ...base, data: { html: `<h2>${course.name}</h2><p>Welcome! This course introduces core frameworks and the tools practitioners use every day.</p><h3>Grading</h3><ul><li>Projects 35%</li><li>Exams 25%</li><li>Case studies 25%</li><li>Reading quizzes 15% (lowest dropped)</li></ul><h3>Late work</h3><p>Late work loses 10% per day for up to three days. Reach out before the deadline if something comes up.</p><h3>Office hours</h3><p>Tuesdays 2–4 PM and by appointment.</p>`, calendar: items.filter(item => item.dueAt).slice(0, 10).map(item => ({ id: item.id, title: item.title, dueAt: item.dueAt, kind: item.kind, type: item.kind, url: `/courses/${courseId}/assignments` })) } });
  if (name === "modules") {
    const buildModule = (index: number, title: string, entries: Array<[string, string, boolean]>) => ({ id: `m${index}`, name: title, position: index, state: index < 3 ? "completed" : "unlocked", items: entries.map(([itemTitle, type, completed], itemIndex) => ({ id: `m${index}-${itemIndex}`, title: itemTitle, position: itemIndex, type, nativePath: type === "Page" ? `/courses/${courseId}/pages#welcome` : null, canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}/modules/items/${index * 10 + itemIndex}`, completed })) });
    return ok({ ...base, data: { modules: [
      buildModule(1, "Week 1 · Foundations", [["Welcome and course map", "Page", true], ["Lecture 01 – Course overview", "File", true], ["Introductions discussion", "Discussion", true]]),
      buildModule(2, "Week 2 · Segmentation", [["Lecture 02 – Market segmentation", "File", true], ["Chapter 6 reading quiz", "Quiz", true]]),
      buildModule(3, "Week 3 · Positioning", [["Lecture 03 – Positioning", "File", true], ["Case study: Warby Parker", "Assignment", true], ["Chapter 7 reading quiz", "Quiz", true]]),
      buildModule(4, "Week 9 · Brand strategy", [["Lecture 09 – Brand architecture", "File", false], ["Chapter 9 reading quiz", "Quiz", false], ["Case study: Patagonia positioning", "Assignment", false], ["Guest speaker notes", "Page", false]]),
      buildModule(5, "Week 10 · Pricing", [["Lecture 10 – Pricing strategy", "File", false], ["Chapter 10 reading quiz", "Quiz", false]]),
    ] } });
  }
  if (name === "pages") return ok({ ...base, data: { pages: [
    { slug: "welcome", title: "Welcome and course map", updatedAt: minutesAgo(now, 60 * 24 * 60), html: "<p>This page explains how the course is organized: weekly modules, a reading quiz each Monday, and case studies every other week.</p><p>Start each week by opening the module, then complete the reading quiz before class.</p>", canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}/pages/welcome` },
    { slug: "case-study-guide", title: "How to write a case study", updatedAt: minutesAgo(now, 60 * 24 * 30), html: "<p>Strong case studies define the problem, analyze options with evidence, and recommend one path.</p><ul><li>Problem statement (1 paragraph)</li><li>Analysis (2–3 pages)</li><li>Recommendation and risks</li></ul>", canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}/pages/case-study-guide` },
    { slug: "guest-speaker-notes", title: "Guest speaker notes", updatedAt: minutesAgo(now, 60 * 24), html: "<p>Notes and slides from guest speakers will be posted here after each session.</p>", canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}/pages/guest-speaker-notes` },
    { slug: "research-guide", title: "Library research guide", updatedAt: minutesAgo(now, 60 * 24 * 45), html: "<p>Use the business databases (IBISWorld, Statista, Mintel) for market data. Cite sources in APA.</p>", canvasUrl: `${FIXTURE_ORIGIN}/courses/${course.canvasCourseId}/pages/research-guide` },
  ] } });
  if (name === "grades") return ok({ ...base, data: {} });
  return { status: 404, body: { error: "Course section not found", code: "SECTION_NOT_FOUND" } };
}

export function fixtureGrades(courseId: string, now: Date) {
  const found = courseOf(courseId, now);
  if (!found) return { courses: [], lastSyncedAt: minutesAgo(now, 9), stale: false };
  const { rows, course } = found;
  const groups = fixtureGroups(courseId);
  const latest = new Map(rows.submissions.map(item => [item.assignmentId, item]));
  const assignments = rows.assignments.filter(item => item.courseId === courseId).map(row => {
    const submission = latest.get(row.id), score = num(submission?.score), dueAt = typeof row.dueAt === "string" ? row.dueAt : row.dueAt?.toISOString() ?? null;
    return { id: row.id, canvasId: row.canvasAssignmentId, name: row.name, groupId: row.assignmentGroupId ?? null, dueAt, pointsPossible: num(row.pointsPossible), score, grade: submission?.grade ?? null,
      status: submission?.state ?? (dueAt && new Date(dueAt) < now ? "unsubmitted" : "upcoming"), excused: submission?.excused ?? false, missing: submission?.missing ?? false, late: submission?.late ?? false, omitted: false, extraCredit: false };
  });
  const weighted = courseId !== COURSE_IDS.enc;
  const current = calculateGrade({ weighted, groups, assignments: assignments.map(item => ({ id: item.id, canvasId: item.canvasId, groupId: item.groupId ?? "ungrouped", pointsPossible: item.pointsPossible, score: item.score, excused: item.excused, omitted: item.omitted, ungraded: item.score == null, extraCredit: item.extraCredit })) });
  return {
    courses: [{
      course: { id: course.id, name: course.name, courseCode: course.courseCode },
      summary: { currentPercent: num(course.currentScore) ?? current.percent, projectedPercent: current.percent, maximumPercent: null, schemeLabel: course.currentGrade, weighted },
      groups: current.groups.map(group => { const source = groups.find(item => item.id === group.id); return { ...group, dropRules: { dropLowest: source?.dropLowest ?? 0, dropHighest: source?.dropHighest ?? 0, neverDropCanvasIds: [] } }; }),
      assignments,
    }],
    lastSyncedAt: minutesAgo(now, 9), stale: false,
  };
}

function quizzes(now: Date): QuizSummary[] {
  const at = (days: number, hour = 23.98) => { const date = new Date(now); date.setHours(0, 0, 0, 0); return new Date(date.getTime() + days * 86_400_000 + hour * 3_600_000).toISOString(); };
  const base = (id: string, course: keyof typeof COURSE_IDS, title: string, extra: Partial<QuizSummary>): QuizSummary => {
    const row = fixtureRows(now).courses.find(item => item.id === COURSE_IDS[course])!;
    return { id, courseId: row.id, courseName: row.name, courseCode: row.courseCode ?? "", title, dueAt: null, unlockAt: null, lockAt: null, pointsPossible: 10, timeLimitMinutes: null, allowedAttempts: 1, questionCount: 10, published: true, attemptsUsed: 0, attemptsRemaining: 1, attemptsKnown: true, actionable: true, canStart: true, status: "available", ...extra };
  };
  return [
    base("q-ch9", "mar", "Chapter 9 reading quiz", { dueAt: at(0, 9), timeLimitMinutes: 15, questionCount: 12, allowedAttempts: 2, attemptsRemaining: 2 }),
    base("q-stats-practice", "sta", "Practice: confidence intervals", { dueAt: at(4), timeLimitMinutes: null, allowedAttempts: -1, attemptsUnlimited: true, attemptsRemaining: null, attemptsUsed: 1, pointsPossible: 0, questionCount: 8 }),
    base("q-bio-ch8", "bsc", "Chapter 8 check-in", { status: "in_progress", dueAt: at(1), timeLimitMinutes: 30, questionCount: 15, attemptsUsed: 1, attemptsRemaining: 0 }),
    base("q-ch10", "mar", "Chapter 10 reading quiz", { status: "not_yet_available", actionable: true, canStart: false, dueAt: at(5, 9), unlockAt: at(3, 9), timeLimitMinutes: 15 }),
    base("q-heuristics", "dig", "Heuristics self-check", { dueAt: at(6), allowedAttempts: null, attemptsKnown: false, attemptsRemaining: null, questionCount: 6 }),
    base("q-proctored", "sta", "Midterm 2 (Respondus)", { status: "unsupported", actionable: false, canStart: false, dueAt: at(6, 14), supportReason: "This quiz requires LockDown Browser, so it must be taken in Canvas.", questionCount: 30, pointsPossible: 100 }),
    base("q-ch8", "mar", "Chapter 8 reading quiz", { status: "completed", actionable: false, canStart: false, dueAt: at(-6, 9), attemptsUsed: 1, attemptsRemaining: 0, hasCompletedAttempt: true, completedAt: at(-6, 8) }),
    base("q-ch7", "mar", "Chapter 7 reading quiz", { status: "completed", actionable: false, canStart: false, dueAt: at(-13, 9), attemptsUsed: 1, attemptsRemaining: 0, hasCompletedAttempt: true, completedAt: at(-13, 8) }),
    base("q-lab-safety", "bsc", "Lab safety quiz", { status: "attempts_exhausted", actionable: false, canStart: false, dueAt: at(-50), attemptsUsed: 2, attemptsRemaining: 0, allowedAttempts: 2, hasCompletedAttempt: true, completedAt: at(-50, 12), pointsPossible: 5 }),
  ];
}

const questions = [
  { id: "qq1", position: 1, type: "multiple_choice", questionTextHtml: "<p>A brand that positions itself on durability and environmental responsibility is primarily using which positioning basis?</p>", pointsPossible: 1, flagged: false, answer: null, options: [{ id: "a", textHtml: "Price and quality" }, { id: "b", textHtml: "Values and benefits" }, { id: "c", textHtml: "Competitor comparison" }, { id: "d", textHtml: "Product class" }] },
  { id: "qq2", position: 2, type: "multiple_answers", questionTextHtml: "<p>Which of the following are elements of brand architecture? Select all that apply.</p>", pointsPossible: 1, flagged: false, answer: null, options: [{ id: "a", textHtml: "Branded house" }, { id: "b", textHtml: "House of brands" }, { id: "c", textHtml: "Penetration pricing" }, { id: "d", textHtml: "Endorsed brands" }] },
  { id: "qq3", position: 3, type: "true_false", questionTextHtml: "<p>Brand equity can be negative.</p>", pointsPossible: 1, flagged: false, answer: null, options: [{ id: "t", textHtml: "True" }, { id: "f", textHtml: "False" }] },
  { id: "qq4", position: 4, type: "short_answer", questionTextHtml: "<p>Name the stage of the customer journey where awareness becomes active consideration.</p>", pointsPossible: 1, flagged: false, answer: null },
  { id: "qq5", position: 5, type: "essay", questionTextHtml: "<p>In two or three sentences, explain why Patagonia’s “Don’t buy this jacket” campaign strengthened its positioning.</p>", pointsPossible: 2, flagged: false, answer: null },
];

export function fixtureFetch(method: string, url: URL, body: Json | null, now: Date): FixtureResponse | null {
  const path = url.pathname;
  if (path === "/api/preferences/timezone") return ok({ timezone: FIXTURE_ZONE });
  if (path === "/api/canvas/sync/status") {
    if (method === "POST") return { status: 202, body: { queued: true, state: "queued" } };
    const kinds = ["planner", "inbox", "announcements", "assignments", "courses", "grades", "favorites", "quizzes", "course_content"];
    return ok({ resources: kinds.map((kind, index) => ({ accountId: "acct", kind, scope: "", lastSuccessAt: minutesAgo(now, 3 + index * 2), lastAttemptAt: minutesAgo(now, 3 + index * 2), consecutiveFailures: 0, errorCode: null, freshness: "fresh" })), jobs: [{ id: "job-next", accountId: "acct", kind: "planner", status: "queued", attempt: 0, runAfter: new Date(now.getTime() + 4 * 60_000).toISOString(), finishedAt: null, errorCode: null, manual: false }] });
  }
  if (path === "/api/views/palette") return ok(buildPaletteIndex(fixtureRows(now), now));
  let match = path.match(/^\/api\/views\/course-search\/([^/]+)$/);
  if (match) {
    const found = courseOf(match[1], now); if (!found) return { status: 404, body: { error: "Course not found" } };
    const base = `/courses/${match[1]}`;
    const entries = [
      ...found.rows.assignments.filter(item => item.courseId === match![1]).map(item => ({ id: item.id, kind: "assignment", title: item.name, detail: "Assignment", href: `${base}/assignments`, external: false })),
      ...["Welcome and course map", "How to write a case study", "Guest speaker notes", "Library research guide"].map((title, index) => ({ id: `p${index}`, kind: "page", title, detail: "Page", href: `${base}/pages`, external: false })),
      ...["Lecture 01 – Course overview.pdf", "Lecture 02 – Market segmentation.pdf", "Practice exam 2.pdf", "Project rubric.xlsx"].map((title, index) => ({ id: `f${index}`, kind: "file", title, detail: "File", href: `${base}/files`, external: false })),
      ...found.rows.announcements.filter(item => item.courseId === match![1]).map(item => ({ id: item.id, kind: "announcement", title: item.title, detail: "Announcement", href: `/inbox?tab=announcements&a=${item.id}`, external: false })),
    ];
    return ok({ course: courseRef(found.course), entries });
  }
  match = path.match(/^\/api\/canvas\/courses\/([^/]+)\/tabs$/);
  if (match) { const found = courseOf(match[1], now); return found ? ok({ course: courseModel(found.course), tabs: tabs(found.course.id, found.course.canvasCourseId), lastSyncedAt: minutesAgo(now, 7), stale: false }) : { status: 404, body: { error: "Course not found" } }; }
  match = path.match(/^\/api\/canvas\/courses\/([^/]+)\/(overview|assignments|announcements|files|syllabus|modules|pages|grades)$/);
  if (match) return section(match[1], match[2], now);
  if (path === "/api/canvas/grades/scenarios") {
    if (method === "POST") return { status: 201, body: { scenario: { id: "scenario-2", name: body?.name ?? "What-if", hypotheticalScores: body?.scores ?? {}, updatedAt: now.toISOString() } } };
    return ok({ scenarios: [] });
  }
  if (path === "/api/canvas/grades") return ok(fixtureGrades(url.searchParams.get("courseId") ?? "", now));
  if (path === "/api/canvas/quizzes") return ok({ quizzes: quizzes(now), freshness: { lastSuccessAt: minutesAgo(now, 4), freshUntil: new Date(now.getTime() + 6 * 60_000).toISOString(), stale: false, refreshing: false, lastErrorCode: null }, refresh: { enqueued: false, jobId: null } });
  match = path.match(/^\/api\/canvas\/quizzes\/([^/]+)\/(preflight|attempt|attempt\/time|submit)$/);
  if (match) {
    const quiz = quizzes(now).find(item => item.id === match![1]) ?? quizzes(now)[0];
    const timing = { startedAt: minutesAgo(now, 1), expiresAt: new Date(now.getTime() + 14 * 60_000).toISOString(), secondsRemaining: 14 * 60 - 3, stale: false };
    if (match[2] === "preflight") return ok({ quiz: { ...quiz, canvasUrl: `${FIXTURE_ORIGIN}/courses/48211/quizzes/1` }, availability: { canStart: quiz.status === "available" }, attempts: { used: quiz.attemptsUsed, remaining: quiz.attemptsRemaining }, activeAttempt: null, formatVerification: "verified" });
    if (match[2] === "attempt" && method === "PATCH") return ok({ saved: true, revision: 2 });
    if (match[2] === "attempt") return ok({ nativeSupported: true, nativeBlock: null, attempt: { id: "sub-1", attempt: 1, state: "untaken", revision: 1 }, questions, timing });
    if (match[2] === "attempt/time") return ok({ timing });
    return ok({ submittedAt: now.toISOString(), attempt: 1, confirmationId: "CG-48211-1" });
  }
  if (path === "/api/canvas/sessions" && method === "GET") return ok({ sessions: [{ id: "session-1", canvasOrigin: FIXTURE_ORIGIN, institutionName: "Example State University", state: "active", updatedAt: minutesAgo(now, 40), interactiveAuthExpiresAt: null }] });
  return null;
}
