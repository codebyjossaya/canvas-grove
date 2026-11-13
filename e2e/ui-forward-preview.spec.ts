import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-11-09T15:00:00.000Z";
const assignments = Array.from({ length: 28 }, (_, index) => ({ id: `a${index}`, name: index === 0 ? "Chapter 2: Marketing Strategy" : `Assignment ${String(index + 1).padStart(2, "0")}`, type: index % 5 === 0 ? "Quiz" : "Assignment", dueAt: `2026-11-${String(10 + index % 12).padStart(2, "0")}T22:00:00.000Z`, pointsPossible: index % 3 ? 10 : 25, status: index < 5 ? "submitted" : "upcoming" }));
const announcements = [{ id: "n1", title: "Research participation opportunities", postedAt: now, bodyHtml: "<p>New opportunities and office hours are available this week.</p>" }, { id: "n2", title: "Week ten checklist", postedAt: "2026-11-08T15:00:00.000Z" }];
const tabs = [{ id: "home", label: "Home", type: "native", nativePath: "/courses/course-1/overview", position: 1 }, { id: "assignments", label: "Assignments", type: "native", nativePath: "/courses/course-1/assignments", position: 2 }, { id: "files", label: "Files", type: "native", nativePath: "/courses/course-1/files", position: 3 }, { id: "syllabus", label: "Syllabus", type: "native", nativePath: "/courses/course-1/syllabus", position: 4 }, { id: "modules", label: "Modules", type: "native", nativePath: "/courses/course-1/modules", position: 5 }, { id: "pages", label: "Pages", type: "native", nativePath: "/courses/course-1/pages", position: 6 }, { id: "grades", label: "Grades", type: "native", nativePath: "/courses/course-1/grades", position: 7 }, { id: "context_external_tool_42", label: "Course Media", type: "external", canvasUrl: "https://canvas.example.edu/courses/1/external_tools/42", position: 8 }];
const course = { id: "course-1", name: "Principles of Marketing", courseCode: "MAR 3023", canvasUrl: "https://canvas.example.edu/courses/1" };
const gradeAssignments = assignments.map((item, index) => ({ ...item, groupId: index < 14 ? "g1" : "g2", score: index < 8 ? (index % 3 ? 9 : 20) : null, grade: index < 8 ? "A" : null, excused: index === 2, missing: index === 9, late: index === 8, omitted: index === 4, extraCredit: false }));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/preferences/timezone", route => route.fulfill({ json: { timezone: "America/New_York" } }));
  await page.route("**/api/canvas/courses/course-1/tabs", route => route.fulfill({ json: { course, tabs, lastSyncedAt: now, stale: false } }));
  await page.route(/\/api\/canvas\/courses\/course-1\/(overview|files|syllabus|modules|pages|grades|assignments|announcements)$/, async route => courseSection(route));
  await page.route("**/api/canvas/grades/scenarios**", async route => { if (route.request().method() === "POST") await route.fulfill({ status: 201, json: { scenario: { id: "s2" } } }); else await route.fulfill({ json: { scenarios: [{ id: "s1", name: "Reach an A−", hypotheticalScores: { a8: 10, a9: 10 }, updatedAt: now }] } }); });
  await page.route(/\/api\/canvas\/grades(?:\?.*)?$/, route => route.fulfill({ json: gradePayload() }));
  await page.route("**/api/canvas/quizzes**", async route => quizRoute(route));
});

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "tablet", width: 820, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`course hub ${viewport.name}`, async ({ page }, testInfo) => { await page.setViewportSize(viewport); await page.goto("/ui-preview?mode=hub"); await expect(page.getByRole("heading", { level: 1, name: "Courses" })).toBeVisible(); await expect(page.getByRole("heading", { level: 2, name: "Principles of Marketing" })).toBeVisible(); expect(await page.getByRole("heading", { level: 2 }).count()).toBeGreaterThanOrEqual(4); await assertVisualIntegrity(page); await capture(page, testInfo.outputPath(`course-hub-${viewport.name}.png`)); });
}

for (const mode of ["course", "files", "syllabus", "modules", "pages", "course-grades"] as const) {
  test(`course ${mode} desktop`, async ({ page }, testInfo) => { await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`/ui-preview?mode=${mode}`); await expect(page.getByRole("heading", { name: "Principles of Marketing" })).toBeVisible(); if (mode === "files") { await page.getByRole("searchbox").fill("Lecture"); await expect(page.getByText("Lecture 01.pdf")).toBeVisible(); } if (mode === "modules") await page.getByText("Module 2: Strategy", { exact: true }).click(); if (mode === "pages") await page.getByRole("button", { name: /Research guide/ }).click(); await capture(page, testInfo.outputPath(`course-${mode}-desktop.png`)); });
}

test("course files mobile", async ({ page }, testInfo) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/ui-preview?mode=files"); await expect(page.getByRole("searchbox")).toBeVisible(); await capture(page, testInfo.outputPath("course-files-mobile.png")); });

test("course grades desktop and controls", async ({ page }, testInfo) => { await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/ui-preview?mode=grades"); await expect(page.getByRole("heading", { level: 1, name: "Principles of Marketing" })).toBeVisible(); await expect(page.getByRole("heading", { name: "What do I need?" })).toBeVisible(); await expect(page.getByRole("combobox")).toHaveCount(0); await expect(page.getByText("Dropped", { exact: true })).toBeVisible(); await expect(page.getByText("Excused", { exact: true })).toBeVisible(); await expect(page.getByText("Omitted", { exact: true })).toBeVisible(); await page.getByLabel("Hypothetical score for Assignment 09").fill("10"); await expect(page.getByText("from 1 change")).toBeVisible(); await page.getByRole("button", { name: "Save scenario" }).click(); await expect(page.getByText("Scenario saved privately in Canvas Grove.")).toBeVisible(); await capture(page, testInfo.outputPath("course-grades-light-desktop.png")); });
test("grades mobile attention filter", async ({ page }, testInfo) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/ui-preview?mode=grades"); await page.getByRole("button", { name: "Needs attention" }).click(); await expect(page.getByText("Missing")).toBeVisible(); await capture(page, testInfo.outputPath("grades-mobile.png")); });
test("course grade picker desktop light and dark", async ({ page }, testInfo) => { await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/ui-preview?mode=grade-picker"); await expect(page.getByRole("heading", { level: 1, name: "Course grades" })).toBeVisible(); await expect(page.getByText("Grades live with each course.", { exact: false })).toBeVisible(); await expect(page.getByRole("region", { name: "Active courses" }).getByRole("link").first()).toBeVisible(); await capture(page, testInfo.outputPath("grade-picker-light-desktop.png")); await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; }); await capture(page, testInfo.outputPath("grade-picker-dark-desktop.png")); });
test("course grade picker mobile", async ({ page }, testInfo) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/ui-preview?mode=grade-picker"); await expect(page.getByText("Canvas Grove does not combine unrelated courses", { exact: false })).toBeVisible(); await assertNoHorizontalOverflow(page); await capture(page, testInfo.outputPath("grade-picker-mobile.png")); });
test("course grades dark mode", async ({ page }, testInfo) => { await page.setViewportSize({ width: 1180, height: 900 }); await page.goto("/ui-preview?mode=grades"); await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; }); await expect(page.getByRole("heading", { level: 1, name: "Principles of Marketing" })).toBeVisible(); await capture(page, testInfo.outputPath("course-grades-dark-desktop.png")); });

test("quiz hub desktop history and pagination", async ({ page }, testInfo) => { await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/ui-preview?mode=quizzes"); await expect(page.getByRole("table")).toBeVisible(); await expect(page.getByText("Completed quiz 01")).toHaveCount(0); await page.getByRole("tab", { name: /History/ }).click(); await expect(page.getByText("Completed quiz 01")).toBeVisible(); await expect(page.getByRole("link", { name: "View details" })).toHaveCount(3); await capture(page, testInfo.outputPath("quiz-hub-history-desktop.png")); });
test("quiz hub mobile actionable", async ({ page }, testInfo) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/ui-preview?mode=quizzes"); await expect(page.getByText("Upcoming quiz 02")).toBeVisible(); await capture(page, testInfo.outputPath("quiz-hub-mobile.png")); });

test("quiz preflight, confirmation, and active question", async ({ page }, testInfo) => { await page.setViewportSize({ width: 1180, height: 900 }); await page.goto("/ui-preview?mode=quiz"); await expect(page.getByRole("heading", { name: "Quiz 08" })).toBeVisible(); await capture(page, testInfo.outputPath("quiz-preflight.png")); await page.getByRole("button", { name: "Start quiz" }).click(); await expect(page.getByRole("dialog")).toBeVisible(); await capture(page, testInfo.outputPath("quiz-start-confirmation.png")); await page.getByRole("button", { name: "Start this attempt" }).click(); await expect(page.getByRole("heading", { name: "Which channel best fits the objective?" })).toBeVisible(); await page.getByLabel("Email").check(); await capture(page, testInfo.outputPath("quiz-active-desktop.png")); });
test("quiz active mobile", async ({ page }, testInfo) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/ui-preview?mode=quiz"); await page.getByRole("button", { name: "Start quiz" }).click(); await page.getByRole("button", { name: "Start this attempt" }).click(); await expect(page.getByText("Question 1 of 2")).toBeVisible(); await capture(page, testInfo.outputPath("quiz-active-mobile.png")); });

for (const state of [
  { name: "29-59", seconds: 1799, expected: "29:59" },
  { name: "5-minutes", seconds: 300, expected: "5:00" },
  { name: "1-minute", seconds: 60, expected: "1:00" },
] as const) {
  test(`interactive auth opener ${state.name}`, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date("2026-11-09T15:00:00.000Z"));
    await page.setViewportSize(state.seconds === 60 ? { width: 390, height: 844 } : { width: 1180, height: 900 });
    const session = authSession(state.seconds);
    await page.route("**/api/canvas/sessions", route => route.fulfill({ json: { sessions: [session] } }));
    await page.goto("/ui-preview?mode=auth-session");
    await expect(page.getByText(state.expected, { exact: true })).toBeVisible();
    await expect(page.getByText("Start a new secure sign-in")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await capture(page, testInfo.outputPath(`interactive-auth-opener-${state.name}.png`));
  });
}

test("interactive auth expired recovery and active session hides countdown", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-09T15:00:00.000Z"));
  await page.setViewportSize({ width: 390, height: 844 });
  const expired = { ...authSession(0), state: "auth-expired", interactiveAuthExpiresAt: null, lastError: "INTERACTIVE_AUTH_TIMEOUT" };
  await page.route("**/api/canvas/sessions", route => route.fulfill({ json: { sessions: [expired] } }));
  await page.goto("/ui-preview?mode=auth-session");
  await expect(page.getByText("Secure sign-in time expired", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start a new secure sign-in" }).click();
  await expect(page.getByText("This ends the expired attempt", { exact: false })).toBeVisible();
  await capture(page, testInfo.outputPath("interactive-auth-expired-mobile.png"));
  let attemptCalls = 0;
  const fresh = authSession(1800);
  await page.route("**/api/canvas/sessions/preview-session/auth-attempt", route => {
    attemptCalls += 1;
    return route.fulfill({ json: { session: fresh } });
  });
  await page.evaluate(() => {
    let closed = false;
    window.open = (() => ({
      get closed() { return closed; },
      location: { href: "", replace() {} },
      focus() {},
      postMessage() {},
      close() { closed = true; },
    })) as unknown as typeof window.open;
  });
  await page.getByRole("button", { name: "Start a new secure sign-in" }).click();
  await expect(page.getByText("30:00", { exact: true })).toBeVisible();
  expect(attemptCalls).toBe(1);

  await page.unrouteAll({ behavior: "wait" });
  await page.route("**/api/canvas/sessions", route => route.fulfill({ json: { sessions: [{ ...authSession(1200), state: "active", interactiveAuthExpiresAt: null }] } }));
  await page.goto("/ui-preview?mode=auth-session");
  await expect(page.getByText("Connected and syncing")).toBeVisible();
  await expect(page.getByText("Time left to finish sign-in")).toHaveCount(0);
});

test("legacy no-attempt session reserves popup before one slow attempt request", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-09T15:00:00.000Z"));
  await page.setViewportSize({ width: 1180, height: 900 });
  const missingAttempt = { ...authSession(0), state: "auth-expired", interactiveAuthExpiresAt: null, lastError: "BROWSER_SESSION_NOT_FOUND" };
  const fresh = authSession(1800);
  let attemptCalls = 0;
  await page.route("**/api/canvas/sessions", route => route.fulfill({ json: { sessions: [missingAttempt] } }));
  await page.route("**/api/canvas/sessions/preview-session/auth-attempt", async route => {
    attemptCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 450));
    await route.fulfill({ json: { session: fresh } });
  });
  await page.goto("/ui-preview?mode=auth-session");
  await page.evaluate(() => {
    let closed = false;
    const scope = window as Window & { __popupNavigations?: string[] };
    scope.__popupNavigations = [];
    window.open = (() => ({
      get closed() { return closed; },
      location: { href: "", replace(value: string) { scope.__popupNavigations!.push(value); } },
      focus() {}, postMessage() {}, close() { closed = true; },
    })) as unknown as typeof window.open;
  });
  const start = page.getByRole("button", { name: "Start a new secure sign-in" });
  await start.click();
  await expect(page.getByRole("button", { name: "Preparing secure browser…" })).toBeDisabled();
  expect(attemptCalls).toBe(1);
  expect(await page.evaluate(() => (window as Window & { __popupNavigations?: string[] }).__popupNavigations)).toEqual([]);
  await expect(page.getByText("30:00", { exact: true })).toBeVisible();
  await page.waitForFunction(() => (window as Window & { __popupNavigations?: string[] }).__popupNavigations?.length === 1);
  expect(attemptCalls).toBe(1);
  expect(await page.evaluate(() => (window as Window & { __popupNavigations?: string[] }).__popupNavigations)).toEqual(["/secure-browser/preview-session"]);
  await capture(page, testInfo.outputPath("interactive-auth-no-attempt-prepared.png"));
});

test("popup with no attempt remains a neutral preparation shell", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-09T15:00:00.000Z"));
  await page.setViewportSize({ width: 390, height: 844 });
  const missingAttempt = { ...authSession(0), state: "auth-expired", interactiveAuthExpiresAt: null, lastError: "BROWSER_SESSION_NOT_FOUND" };
  let connectCalls = 0;
  await page.route("**/api/canvas/sessions/preview-session", route => route.fulfill({ json: { session: missingAttempt } }));
  await page.route("**/api/canvas/sessions/preview-session/connect", route => { connectCalls += 1; return route.fulfill({ status: 409, json: { code: "INVALID_SESSION_STATE", error: "Start a new secure sign-in before connecting." } }); });
  await page.goto("/ui-preview?mode=auth-popup");
  await expect(page.getByRole("heading", { name: "Preparing secure browser" })).toBeVisible();
  await expect(page.getByText("Canvas Grove is reserving your isolated browser", { exact: false })).toBeVisible();
  await expect(page.getByText("Secure browser needs attention")).toHaveCount(0);
  expect(connectCalls).toBe(0);
  await capture(page, testInfo.outputPath("interactive-auth-no-attempt-popup-mobile.png"));
});

test("failed attempt preparation never navigates the reserved popup", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-09T15:00:00.000Z"));
  const missingAttempt = { ...authSession(0), state: "auth-expired", interactiveAuthExpiresAt: null, lastError: "BROWSER_SESSION_NOT_FOUND" };
  let attemptCalls = 0;
  await page.route("**/api/canvas/sessions", route => route.fulfill({ json: { sessions: [missingAttempt] } }));
  await page.route("**/api/canvas/sessions/preview-session/auth-attempt", route => { attemptCalls += 1; return route.fulfill({ status: 503, json: { code: "BROWSER_HOST_OFFLINE", error: "Browser host unavailable" } }); });
  await page.goto("/ui-preview?mode=auth-session");
  await page.evaluate(() => {
    let closed = false;
    const scope = window as Window & { __popupNavigations?: string[] };
    scope.__popupNavigations = [];
    window.open = (() => ({
      get closed() { return closed; }, location: { href: "", replace(value: string) { scope.__popupNavigations!.push(value); } },
      focus() {}, postMessage() {}, close() { closed = true; },
    })) as unknown as typeof window.open;
  });
  await page.getByRole("button", { name: "Start a new secure sign-in" }).click();
  await expect(page.getByText("The secure browser host is offline")).toBeVisible();
  expect(attemptCalls).toBe(1);
  expect(await page.evaluate(() => (window as Window & { __popupNavigations?: string[] }).__popupNavigations)).toEqual([]);
});

test("interactive auth popup preserves the deadline across retry and has dark warning", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-09T15:00:00.000Z"));
  await page.setViewportSize({ width: 1180, height: 760 });
  const session = authSession(300);
  const seen: string[] = [];
  let connectCalls = 0;
  await page.route("**/api/canvas/sessions/preview-session", route => { seen.push(session.interactiveAuthExpiresAt!); return route.fulfill({ json: { session } }); });
  await page.route("**/api/canvas/sessions/preview-session/connect", route => {
    connectCalls += 1;
    if (connectCalls === 1) return route.fulfill({ status: 503, json: { code: "BROWSER_HOST_ERROR", error: "Temporary viewer interruption" } });
    return route.fulfill({ json: { url: "about:blank", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  });
  await page.goto("/ui-preview?mode=auth-popup");
  await expect(page.getByText("5:00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry secure sign-in" }).click();
  await expect(page.getByText("5:00", { exact: true })).toBeVisible();
  expect(seen).toEqual([session.interactiveAuthExpiresAt, session.interactiveAuthExpiresAt]);
  expect(new Set(seen).size).toBe(1);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await capture(page, testInfo.outputPath("interactive-auth-popup-warning-dark.png"));
});

function authSession(seconds: number) {
  const now = Date.parse("2026-11-09T15:00:00.000Z");
  return {
    id: "preview-session",
    canvasOrigin: "https://canvas.example.edu",
    institutionName: "Example University",
    state: "awaiting-login",
    updatedAt: new Date(now).toISOString(),
    interactiveAuthExpiresAt: new Date(now + seconds * 1000).toISOString(),
  };
}

async function courseSection(route: Route) {
  const section = new URL(route.request().url()).pathname.split("/").at(-1);
  const data: Record<string, unknown> = section === "overview" ? { upcoming: assignments.slice(0, 6), announcements } : section === "files" ? { folders: [{ id: "f1", name: "Lectures", filesCount: 12 }, { id: "f2", name: "Research", filesCount: 7 }, { id: "f3", name: "Exam review", filesCount: 5 }], files: Array.from({ length: 32 }, (_, index) => ({ id: `file${index}`, displayName: index === 0 ? "Lecture 01.pdf" : `Course resource ${index + 1}.pdf`, contentType: "application/pdf", size: 240000 + index * 2000, updatedAt: now, downloadPath: `/download/${index}` })) } : section === "syllabus" ? { html: "<h2>Course purpose</h2><p>This course introduces strategic marketing decisions, customer insight, and ethical practice.</p><h2>Grading policy</h2><p>Grades combine quizzes, SmartBook work, and applied projects. Late work follows the published policy.</p><h2>Participation</h2><p>Come prepared to discuss current examples and complete the weekly learning sequence.</p>", calendar: assignments.slice(0, 8) } : section === "modules" ? { modules: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, name: `Module ${index + 1}: ${["Foundations", "Strategy", "Research", "Segmentation", "Product", "Promotion"][index]}`, items: assignments.slice(index * 3, index * 3 + 5).map(item => ({ ...item, title: item.name, completed: index < 2 })) })) } : section === "pages" ? { pages: [{ slug: "research-guide", title: "Research guide", updatedAt: now, html: "<p>A practical guide to research participation, methods, and submission expectations.</p>", canvasUrl: "https://canvas.example.edu/courses/1/pages/research-guide" }, { slug: "exam-review", title: "Exam review", updatedAt: now, html: "<p>Review concepts from modules one through four.</p>" }] } : section === "grades" ? { groups: [{ id: "g1", name: "Quizzes", groupWeight: 35 }, { id: "g2", name: "Coursework", groupWeight: 65 }], assignments: gradeAssignments.map((assignment, index) => ({ assignment, submission: index < 8 ? { score: assignment.score, state: "graded" } : null })) } : { [section || "items"]: section === "announcements" ? announcements : assignments };
  await route.fulfill({ json: { course, section, data, lastSyncedAt: now, stale: false } });
}

function gradePayload() { return { courses: [{ course: { id: "course-1", name: course.name, courseCode: course.courseCode }, summary: { currentPercent: 84.2, projectedPercent: 84.2, maximumPercent: null, schemeLabel: "B", weighted: true }, groups: [{ id: "g1", name: "Quizzes", weight: 35, earned: 69, possible: 80, percent: 86.25, droppedAssignmentIds: ["a0"] }, { id: "g2", name: "Coursework", weight: 65, earned: 180, possible: 220, percent: 81.8, droppedAssignmentIds: [] }], assignments: gradeAssignments }], lastSyncedAt: now, stale: false }; }

async function quizRoute(route: Route) {
  const url = route.request().url(), method = route.request().method();
  if (url.endsWith("/preflight")) return route.fulfill({ json: { quiz: { id: "quiz-1", courseId: "course-1", courseName: course.name, courseCode: course.courseCode, title: "Quiz 08", dueAt: "2026-11-10T22:00:00.000Z", pointsPossible: 10, timeLimitMinutes: 20, questionCount: 2, status: "available" }, availability: { canStart: true }, attempts: { used: 0, remaining: 2 }, formatVerification: "verified" } });
  if (url.endsWith("/attempt") && method === "POST") return route.fulfill({ json: activeAttempt() });
  if (url.endsWith("/attempt") && method === "PATCH") return route.fulfill({ json: { revision: 1 } });
  if (url.endsWith("/attempt/time")) return route.fulfill({ json: { timing: activeAttempt().timing } });
  const quizzes = [...Array.from({ length: 13 }, (_, index) => ({ id: `q${index}`, courseId: "course-1", courseName: course.name, courseCode: course.courseCode, title: index === 0 ? "Quiz 08" : `Upcoming quiz ${String(index + 1).padStart(2, "0")}`, dueAt: `2026-11-${String(10 + index % 12).padStart(2, "0")}T22:00:00.000Z`, pointsPossible: 10, timeLimitMinutes: 20, questionCount: 10, attemptsUsed: 0, attemptsRemaining: 2, attemptsKnown: true, status: index === 0 ? "in_progress" : "available", actionable: true })), ...Array.from({ length: 3 }, (_, index) => ({ id: `done${index}`, courseId: "course-1", courseName: course.name, courseCode: course.courseCode, title: `Completed quiz ${String(index + 1).padStart(2, "0")}`, dueAt: "2026-11-01T22:00:00.000Z", completedAt: "2026-11-01T20:00:00.000Z", pointsPossible: 10, timeLimitMinutes: 20, questionCount: 10, attemptsUsed: 1, attemptsRemaining: 1, attemptsKnown: true, status: "completed", actionable: false }))];
  return route.fulfill({ json: { quizzes, freshness: { lastSuccessAt: now, freshUntil: now, stale: false, refreshing: false, lastErrorCode: null }, refresh: { enqueued: false, jobId: null } } });
}
function activeAttempt() { return { nativeSupported: true, attempt: { id: "attempt-1", attempt: 1, state: "untaken" }, questions: [{ id: "q1", position: 1, type: "multiple_choice", questionTextHtml: "<p>Which channel best fits the objective?</p>", pointsPossible: 1, flagged: false, answer: null, options: [{ id: 1, textHtml: "Email" }, { id: 2, textHtml: "Search" }, { id: 3, textHtml: "Social" }] }, { id: "q2", position: 2, type: "short_answer", questionTextHtml: "<p>Explain your reasoning.</p>", pointsPossible: 2, flagged: false, answer: null, options: [] }], timing: { startedAt: now, expiresAt: "2026-11-09T15:20:00.000Z", secondsRemaining: 1200, stale: false, error: null } }; }

async function assertVisualIntegrity(page: Page) {
  const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => (link as HTMLLinkElement).href));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect((await page.request.get(href)).status(), href).toBeLessThan(400);
  expect(await page.locator("body").innerText()).not.toMatch(/â|Â|Ã|�/);
}

async function capture(page: Page, path: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path, fullPage: true });
}

async function assertNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth + 1);
}
