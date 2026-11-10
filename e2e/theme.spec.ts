import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "../lib/theme";

const root = process.cwd();
const globalCss = `${readFileSync(resolve(root, "app/globals.css"), "utf8")}\n${readFileSync(resolve(root, "app/theme.css"), "utf8")}`;
const scopedCss: Record<string, string> = {
  "/courses": readFileSync(
    resolve(root, "app/(workspace)/courses/courses.module.css"),
    "utf8",
  ),
  "/grades": readFileSync(
    resolve(root, "components/ui/grades-workspace.module.css"),
    "utf8",
  ),
  "/quiz": readFileSync(
    resolve(root, "components/ui/quiz-mode.module.css"),
    "utf8",
  ),
  "/popup": readFileSync(
    resolve(root, "components/ui/secure-browser-popup.module.css"),
    "utf8",
  ),
  "/popup-blocked": readFileSync(
    resolve(root, "components/ui/secure-browser-popup.module.css"),
    "utf8",
  ),
};
let server: Server;
let origin: string;

const icons = `<span class="theme-icon theme-icon-moon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.6 8.6 0 1 0 20.5 14.2Z"/></svg></span><span class="theme-icon theme-icon-sun"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/></svg></span>`;
const toggle = (reset = false, compact = true) =>
  `<div class="theme-control${compact ? " compact" : ""}"><button type="button" class="theme-toggle" aria-label="Toggle color theme" title="Toggle color theme">${icons}</button>${reset ? `<button type="button" class="theme-reset" aria-hidden="true" tabindex="-1" data-visible="false">Use system setting</button>` : ""}</div>`;
const navIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle></svg>`;
const shell = (body: string) =>
  `<div class="shell"><aside class="sidebar"><div class="brand sidebar-brand"><span class="grove-mark"><i></i><i></i><i></i></span><span>Canvas Grove</span></div><nav class="side-nav"><a class="active">${navIcon}<span>Today</span></a><a>${navIcon}<span>Planner</span></a><a>${navIcon}<span>Courses</span></a><a>${navIcon}<span>Quizzes</span></a></nav><div class="sidebar-bottom">Continuous sync</div></aside><div class="workspace"><header class="topbar"><strong>Canvas Grove</strong><span class="sync-indicator fresh"><i class="sync-indicator-mark"></i>Synced</span><div class="top-actions">${toggle()}<span class="fixture-avatar"></span></div></header>${body}</div></div>`;

function content(path: string) {
  if (path === "/grades")
    return shell(
      `<main class="wrap"><a class="back-link">&larr; Principles of Marketing</a><header class="head"><div><p class="eyebrow">Principles of Marketing</p><h1>What-If gradebook</h1><p>Explore a scenario for this course without changing Canvas.</p></div></header><section class="summary"><div class="metric"><span>Canvas grade</span><strong>87.4%</strong></div><div class="metric hypothetical"><span>What-If grade</span><strong>90.1%</strong></div><div class="metric"><span>Maximum</span><strong>94.2%</strong></div></section><div class="table"><div class="tableHead"><span>Assignment</span><span>Status</span><span>Canvas</span><span>What-If</span></div><div class="row"><div><strong>Quiz 4</strong><small>20 points</small></div><div>Missing</div><div>&mdash;</div><div><input value="18"></div></div><div class="row"><div><strong>Case brief</strong><small>50 points</small></div><div>Graded</div><div>43</div><div><input value="47"></div></div></div></main>`,
    );
  if (path === "/landing")
    return `<main class="landing"><nav class="landing-nav"><span class="brand">Canvas Grove</span><div class="landing-actions">${toggle()}<button class="button ghost">Sign in</button><button class="button primary">Create your grove</button></div></nav><section class="hero"><div class="hero-copy"><p class="eyebrow">Your semester, finally in focus</p><h1>Everything in Canvas.<br><em>Nothing in the way.</em></h1><p class="hero-lede">Assignments, grades, announcements, and study plans in one calm workspace.</p><div class="hero-actions"><button class="button primary large">Get started</button><button class="button secondary large">I have an account</button></div></div><div class="hero-preview"><div class="preview-top"></div><div class="preview-body"><div class="preview-rail"><b></b><i></i><i></i><i></i></div><div class="preview-content"><small>GOOD MORNING</small><h2>Here’s what needs your attention.</h2><div class="preview-focus"><div><strong>Problem Set 6</strong><small>Due tomorrow</small></div><b>74%</b></div><div class="preview-grid"><div></div><div></div><div></div></div></div></div></div></section></main>`;
  if (path === "/dashboard")
    return shell(
      `<main class="dashboard"><header class="dashboard-head"><div><p class="eyebrow">Monday, November 9</p><h1>Good morning.</h1><p>Your next steps, already prioritized.</p></div></header><section class="focus-card"><div class="focus-date"><strong>09</strong><span>NOV</span></div><div class="focus-copy"><h2>Marketing quiz</h2><p>Due today · 20 points</p><div class="progress"><i style="width:68%"></i></div></div><button class="button primary">Continue</button></section><div class="dashboard-grid"><section class="panel agenda"><div class="section-head"><h2>Today</h2></div><div class="agenda-list"><article><time>10:30</time><i class="agenda-line"></i><div><strong>Review chapter 8</strong><small>Principles of Marketing</small></div></article><article><time>3:00</time><i class="agenda-line amber"></i><div><strong>Submit case brief</strong><small>Business Law</small></div></article></div></section><section class="panel"><div class="section-head"><h2>Course pulse</h2></div><div class="cache-note">Everything is up to date.</div></section></div></main>`,
    );
  if (path === "/courses")
    return shell(
      `<main class="dashboard"><header class="dashboard-head"><div><p class="eyebrow">Courses</p><h1>Your semester.</h1></div></header><div class="list"><div class="head"><span>Course</span><span>Term</span><span>Grade</span><span></span></div><article class="row"><div class="title"><strong>Principles of Marketing</strong><small>MAR3023 · Fall 2026</small></div><div class="cell"><strong>Active</strong><span>Enrolled</span></div><div class="cell"><strong>87.4%</strong><span>B+</span></div><div class="action"><a class="open">Open course</a></div></article><article class="row"><div class="title"><strong>Business Law</strong><small>BUL4310 · Fall 2026</small></div><div class="cell"><strong>Active</strong></div><div class="cell"><strong>91.2%</strong><span>A-</span></div><div class="action"><a class="open">Open course</a></div></article></div></main>`,
    );
  if (path === "/course")
    return shell(
      `<main class="dashboard route-page"><a class="back-link">← All courses</a><header class="course-detail-head"><div><p class="eyebrow">MAR3023</p><h1>Principles of Marketing</h1><p>Fall 2026</p></div><div class="grade-summary"><span>Current grade</span><strong>87.4%</strong><small>B+</small></div></header><nav class="course-tabs"><a aria-current="page">Overview</a><a>Assignments</a><a>Modules</a><a>Files</a><a>Syllabus</a></nav><div class="course-detail-grid"><section class="panel"><div class="section-head"><h2>Assignments</h2></div><div class="course-assignment-list"><article><div><strong>Consumer behavior case</strong><small>20 points</small></div><time>Nov 12</time></article><article><div><strong>Quiz 4</strong><small>10 questions</small></div><time>Nov 15</time></article></div></section><section class="panel"><div class="section-head"><h2>Course pulse</h2></div><p class="cache-note">Everything is up to date.</p></section></div></main>`,
    );
  if (path === "/quiz")
    return `<main class="focus"><header class="focusBar"><div><span>Principles of Marketing</span><strong>Quiz 4</strong></div><div class="attemptMeta"><time>24:18</time>${toggle()}</div></header><div class="quizLayout"><aside class="questionNav"><strong>Questions</strong><div><button class="current">1</button><button>2</button><button>3</button><button>4</button></div><small>1 of 4 answered</small></aside><section class="question"><div class="questionHead"><span>Question 1 of 4</span><button class="flag">Flag</button></div><h1>Which concept best describes the value a customer expects?</h1><fieldset class="options"><legend>Select one</legend><label><input type="radio" name="q"><span>Customer lifetime value</span></label><label><input type="radio" name="q"><span>Perceived customer value</span></label><label><input type="radio" name="q"><span>Market penetration</span></label></fieldset><footer><button class="button secondary">Previous</button><button class="button primary">Next question</button></footer></section></div><div class="review fixture-modal" role="dialog"><section><p class="eyebrow">Review</p><h2>Submit this quiz?</h2><p>Unanswered questions will remain blank.</p><footer><button class="button secondary">Keep working</button><button class="button primary">Submit quiz</button></footer></section></div></main>`;
  if (path === "/settings")
    return shell(
      `<main class="dashboard route-page"><header class="dashboard-head"><div><p class="eyebrow">Settings</p><h1>Connection, sync & privacy.</h1><p>Control access and appearance.</p></div></header><section class="panel appearance-panel"><div><p class="eyebrow">Display</p><h2>Appearance</h2><p>Switch themes or follow this device.</p></div>${toggle(true, false)}</section><section class="panel"><p class="eyebrow">Dates & deadlines</p><h2>Time zone</h2><label>Display time zone<select><option>Automatic (America/New_York)</option><option>UTC</option></select></label><small>Canvas timestamps remain exact instants.</small></section><section class="sync-panel"><div class="sync-panel-head"><div><p class="eyebrow">Canvas freshness</p><h2>Background sync</h2><p>Continuously refreshed in the background.</p></div><div><button class="button primary fixture-sync">Sync now</button><button class="button secondary">Check status</button></div></div><div class="sync-health fresh"><i></i><div><strong>Canvas data is fresh</strong><small>Last success 2 minutes ago</small></div></div></section></main>`,
    );
  if (path === "/auth")
    return `<main class="orientation"><header class="orientation-bar"><span class="brand">Canvas Grove</span>${toggle()}</header><section class="cl-card fixture-auth"><h1 class="cl-headerTitle">Sign in to Canvas Grove</h1><p class="cl-headerSubtitle">Welcome back. Continue with your account.</p><label class="cl-formFieldLabel">Email address<input class="cl-formFieldInput" value="student@example.edu"></label><button class="button primary">Continue</button><button class="cl-socialButtonsBlockButton">Continue with Google</button></section></main>`;
  if (path === "/popup")
    return `<main class="shell popup-fixture"><header class="toolbar"><div class="identity"><i></i><div><strong>Secure live browser</strong><span>Example University Canvas</span></div></div><div class="actions">${toggle()}<button class="close">Close</button></div></header><section class="stage"><div class="placeholder"><span class="line"></span><h1>Opening institution sign-in</h1><p>Only enter credentials after your institution sign-in page appears.</p></div><div class="status">Connecting secure viewer</div></section></main>`;
  if (path === "/popup-blocked")
    return `<main class="shell popup-fixture"><header class="toolbar"><div class="identity"><i></i><div><strong>Secure live browser</strong><span>Example University Canvas</span></div></div><div class="actions">${toggle()}<button class="close">Close</button></div></header><section class="stage"><div class="placeholder" role="alert"><h1>Institution sign-in redirect blocked</h1><div class="blockedCopy"><p class="blockedHost"><span>Blocked hostname</span><code>login.example.edu</code></p><p>Canvas Grove stopped this destination before showing it to you. Confirm the hostname belongs to your institution. If it does, retry or reconnect with that exact sign-in domain; otherwise cancel the session.</p></div><div class="errorActions"><button class="retry">Retry secure sign-in</button><button class="cancel">Close and return</button></div></div><div class="status">Connection interrupted</div></section></main>`;
  return shell(
    `<main class="dashboard"><header class="dashboard-head"><div><p class="eyebrow">System states</p><h1>Clear, useful feedback.</h1></div></header><section class="panel fixture-states"><div class="connection-success"><strong>Connected</strong><span>Your saved Canvas session is healthy.</span></div><div class="host-notice starting"><strong>Starting secure browser</strong><span>This can take a moment.</span></div><div class="error-notice"><strong>Canvas could not be reached</strong><p>Previously synced data remains available.</p><button>Retry</button></div><div class="empty-sync"><h2>No assignments due</h2><p>You’re clear for now.</p></div><div class="fixture-skeleton skeleton"></div><label>Institution Canvas URL<input placeholder="school.instructure.com"></label><button class="button primary" disabled>Continue</button></section></main>`,
  );
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://fixture").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${globalCss}\n${scopedCss[path] || ""}\n.fixture-avatar{width:30px;height:30px;border-radius:50%;background:var(--surface-muted)}.fixture-modal{position:fixed;inset:0;z-index:20}.fixture-modal>section{max-width:520px}.fixture-auth{width:min(430px,calc(100% - 32px));margin:8vh auto;padding:32px;display:grid;gap:18px}.fixture-auth label{display:grid;gap:7px}.fixture-states{margin-top:24px;display:grid;gap:16px}.fixture-skeleton{height:54px;border-radius:8px}.popup-fixture{grid-template-columns:none}@media(max-width:600px){.fixture-modal{padding:12px}.fixture-modal>section{padding:22px}}</style><script>${THEME_INIT_SCRIPT}</script></head><body>${content(path)}<script>const key=${JSON.stringify(THEME_STORAGE_KEY)};function syncReset(){const b=document.querySelector('.theme-reset');if(!b)return;const visible=(localStorage.getItem(key)||'system')!=='system';b.dataset.visible=String(visible);b.setAttribute('aria-hidden',String(!visible));b.tabIndex=visible?0:-1}document.querySelectorAll('.theme-toggle').forEach(button=>button.addEventListener('click',()=>{const current=document.documentElement.dataset.theme==='dark'?'dark':'light',next=current==='dark'?'light':'dark';localStorage.setItem(key,next);document.documentElement.dataset.theme=next;document.documentElement.dataset.themePreference=next;document.documentElement.style.colorScheme=next;syncReset()}));document.querySelector('.theme-reset')?.addEventListener('click',()=>{localStorage.removeItem(key);const next=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=next;document.documentElement.dataset.themePreference='system';document.documentElement.style.colorScheme=next;syncReset()});syncReset();</script></body></html>`,
    );
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("theme fixture failed to listen");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
});

test("system theme, icon action, keyboard toggle, persistence, and reset", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(`${origin}/settings`);
  const toggleButton = page
    .getByRole("button", { name: "Toggle color theme" })
    .first();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggleButton.locator(".theme-icon-sun")).toBeVisible();
  await expect(toggleButton.locator(".theme-icon-moon")).toBeHidden();
  const before = await toggleButton.boundingBox();
  await toggleButton.focus();
  await expect(toggleButton).toHaveCSS("outline-style", "solid");
  await expect(toggleButton).toHaveCSS("outline-width", "3px");
  await page.screenshot({
    path: testInfo.outputPath("toggle-focus-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY),
  ).toBe("light");
  expect(await toggleButton.boundingBox()).toEqual(before);
  await expect(toggleButton.locator(".theme-icon-moon")).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Use system setting" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY),
  ).toBeNull();
  await page.mouse.move(0, 0);
  const resting = await toggleButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await toggleButton.hover();
  const hovered = await toggleButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(hovered).not.toBe(resting);
});

test("grades stay course-scoped in navigation and fixtures", async ({
  page,
}) => {
  await page.goto(`${origin}/dashboard`);
  await expect(page.locator(".side-nav")).not.toContainText("Grades");
  await page.goto(`${origin}/grades`);
  await expect(page.locator("main")).toContainText("Principles of Marketing");
  await expect(page.locator("main select")).toHaveCount(0);
  await expect(
    page.getByText("What-If gradebook", { exact: true }),
  ).toBeVisible();
});

const routes = [
  "landing",
  "dashboard",
  "courses",
  "course",
  "grades",
  "quiz",
  "settings",
  "auth",
  "states",
  "popup",
  "popup-blocked",
];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
];
test("capture light and dark route/state matrix", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"] as const) {
      await page.addInitScript(
        ({ key, theme }) => localStorage.setItem(key, theme),
        { key: THEME_STORAGE_KEY, theme },
      );
      for (const route of routes) {
        await page.goto(`${origin}/${route}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(
          page.getByRole("button", { name: "Toggle color theme" }).first(),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`${route}-${viewport.name}-${theme}.png`),
          fullPage: true,
        });
      }
    }
  }
});

test("blocked redirect state reveals only a hostname and keeps recovery accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/popup-blocked`);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("login.example.edu");
  await expect(alert).not.toContainText(
    /SAMLRequest|SAMLResponse|RelayState|https:\/\//i,
  );
  await expect(
    page.getByRole("button", { name: "Retry secure sign-in" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close and return" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry secure sign-in" }).focus();
  await expect(
    page.getByRole("button", { name: "Retry secure sign-in" }),
  ).toHaveCSS("outline-style", "solid");
});
