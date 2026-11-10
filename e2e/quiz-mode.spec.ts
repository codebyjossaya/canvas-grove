import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

const quizId = "11111111-1111-4111-8111-111111111111";
const quizPath = `/quizzes/${quizId}`;
const attemptPath = `/api/canvas/quizzes/${quizId}/attempt`;

const quiz = {
  id: quizId,
  courseId: "course-1",
  courseName: "Safety Engineering",
  courseCode: "SAFE 101",
  title: "Native Classic Quiz",
  dueAt: null,
  unlockAt: null,
  lockAt: null,
  pointsPossible: 2,
  timeLimitMinutes: 10,
  allowedAttempts: 2,
  questionCount: 2,
  published: true,
  attemptsUsed: 0,
  attemptsRemaining: 2,
  status: "available",
};

const active = {
  attempt: { id: "901", attempt: 1, state: "untaken" },
  questions: [
    {
      id: "101",
      position: 1,
      type: "multiple_choice",
      questionTextHtml: "<p>Pick your own answer</p>",
      pointsPossible: 1,
      flagged: false,
      answer: null,
      options: [
        { id: 1, textHtml: "First" },
        { id: 2, textHtml: "Second" },
      ],
    },
    {
      id: "102",
      position: 2,
      type: "short_answer",
      questionTextHtml: "<p>Write your own answer</p>",
      pointsPossible: 1,
      flagged: false,
      answer: null,
      options: [],
    },
  ],
  timing: {
    startedAt: "2026-11-08T12:00:00.000Z",
    expiresAt: "2026-11-08T12:10:00.000Z",
    secondsRemaining: 600,
    stale: false,
    error: null,
  },
};

test.describe("native Classic Quiz safety gates", () => {
  test.skip(!process.env.E2E_CLERK_USER_EMAIL, "E2E_CLERK_USER_EMAIL is required for protected Quiz Mode acceptance tests");

  test.beforeEach(async ({ context, page }) => {
    await setupClerkTestingToken({ context });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });
  });

  test("does not start or submit until each explicit confirmation and flushes manual saves", async ({ page }) => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    let revision = 0;

    await page.route(`**/api/canvas/quizzes/${quizId}/preflight`, async route => {
      await route.fulfill({ json: { quiz, availability: { canStart: true, status: "available" }, attempts: { used: 0, remaining: 2 } } });
    });
    await page.route(`**${attemptPath}`, async route => {
      const request = route.request();
      const body = request.postDataJSON?.() ?? {};
      calls.push({ method: request.method(), url: request.url(), body });
      if (request.method() === "POST") {
        expect(request.headers()["x-idempotency-key"]).toMatch(/^[A-Za-z0-9]/);
        await route.fulfill({ json: active });
        return;
      }
      if (request.method() === "PATCH") {
        expect(request.headers()["x-idempotency-key"]).toMatch(/^[A-Za-z0-9]/);
        revision += 1;
        await route.fulfill({ json: { saved: true, revision, savedAt: new Date().toISOString() } });
        return;
      }
      await route.fulfill({ json: active });
    });
    await page.route(`**/api/canvas/quizzes/${quizId}/submit`, async route => {
      const request = route.request();
      const body = request.postDataJSON?.() ?? {};
      calls.push({ method: request.method(), url: request.url(), body });
      expect(request.headers()["x-idempotency-key"]).toMatch(/^[A-Za-z0-9]/);
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ json: { attempt: 1, submittedAt: "2026-11-08T12:05:00.000Z", confirmationId: "901" } });
    });

    await page.goto(quizPath);
    await expect(page.getByRole("heading", { name: quiz.title })).toBeVisible();
    expect(calls).toHaveLength(0);

    await page.getByRole("button", { name: "Start quiz" }).click();
    await expect(page.getByRole("dialog", { name: "Start this attempt?" })).toBeVisible();
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: "Start this attempt", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Pick your own answer" })).toBeVisible();
    expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/attempt"))).toHaveLength(1);

    await page.getByLabel("First").check();
    await page.getByRole("button", { name: "Flag question" }).click();
    await page.getByRole("button", { name: "Next question" }).click();
    await page.getByLabel("Your answer").fill("My manual answer");
    await page.getByRole("button", { name: "Review answers" }).click();
    await expect(page.getByRole("dialog", { name: "Check your attempt" })).toBeVisible();

    const patches = calls.filter(call => call.method === "PATCH");
    expect(patches.some(call => call.body.questionId === "101" && call.body.answer === 1)).toBeTruthy();
    expect(patches.some(call => call.body.questionId === "101" && call.body.flagged === true)).toBeTruthy();
    expect(patches.some(call => call.body.questionId === "102" && call.body.answer === "My manual answer")).toBeTruthy();
    expect(calls.filter(call => call.url.endsWith("/submit"))).toHaveLength(0);

    await page.getByRole("button", { name: "Continue to submit" }).click();
    await expect(page.getByRole("dialog", { name: "Submit this attempt?" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(calls.filter(call => call.url.endsWith("/submit"))).toHaveLength(0);
    await page.getByRole("button", { name: "Submit quiz" }).click();
    await expect(page.getByRole("heading", { name: "Canvas confirmed your quiz." })).toBeVisible();

    const submits = calls.filter(call => call.url.endsWith("/submit"));
    expect(submits).toHaveLength(1);
    expect(submits[0].body).toMatchObject({ confirmSubmit: true, expectedAttempt: 1, pendingSaves: 0 });
  });

  test("blocks unsupported quizzes without creating an attempt", async ({ page }) => {
    let mutations = 0;
    await page.route(`**/api/canvas/quizzes/${quizId}/preflight`, async route => {
      await route.fulfill({
        json: {
          quiz: { ...quiz, status: "unsupported", supportReason: "This quiz requires Honorlock." },
          availability: { canStart: false, status: "unsupported", reason: "This quiz requires Honorlock." },
          attempts: { used: 0, remaining: 2 },
        },
      });
    });
    await page.route(`**${attemptPath}`, async route => {
      if (route.request().method() !== "GET") mutations += 1;
      await route.fulfill({ status: 409, json: { error: "Blocked" } });
    });
    await page.goto(quizPath);
    await expect(page.getByText("This quiz requires Canvas")).toBeVisible();
    await expect(page.getByText("This quiz requires Honorlock.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start quiz" })).toHaveCount(0);
    expect(mutations).toBe(0);
  });

  test("hidden formats require explicit consent and preserve an unsupported active attempt for Canvas", async ({ page }) => {
    let starts = 0;
    const canvasUrl = "https://school.instructure.com/courses/55/quizzes/77";
    await page.route(`**/api/canvas/quizzes/${quizId}/preflight`, async route => {
      await route.fulfill({
        json: {
          quiz: { ...quiz, canvasUrl },
          availability: { canStart: true, status: "available" },
          attempts: { used: 0, remaining: 2 },
          formatVerification: "after_start",
          startWarning: "Canvas hides this quiz's question formats until an attempt starts. Starting consumes an attempt and may start its timer. If native mode cannot reproduce one safely, your active attempt will be preserved and you will continue in Canvas.",
        },
      });
    });
    await page.route(`**${attemptPath}`, async route => {
      if (route.request().method() !== "POST") {
        await route.fulfill({ status: 405, json: { error: "Unexpected method" } });
        return;
      }
      starts += 1;
      await route.fulfill({
        json: {
          nativeSupported: false,
          nativeBlock: {
            code: "UNSUPPORTED_QUESTION_TYPE",
            message: "Question 1 uses a Canvas type native Quiz Mode cannot safely save. Your active attempt has been preserved; continue it directly in Canvas.",
            canvasUrl,
          },
          attempt: { id: "901", attempt: 1, state: "untaken" },
          questions: [],
          timing: { startedAt: "2026-11-08T12:00:00.000Z", expiresAt: "2026-11-08T12:10:00.000Z", secondsRemaining: 590, stale: false, error: null },
        },
      });
    });

    await page.goto(quizPath);
    await expect(page.getByText("Formats are checked after you start")).toBeVisible();
    expect(starts).toBe(0);
    await page.getByRole("button", { name: "Start quiz" }).click();
    const dialog = page.getByRole("dialog", { name: "Start this attempt?" });
    await expect(dialog).toContainText("consumes an attempt");
    await expect(dialog).toContainText("active attempt will be preserved");
    expect(starts).toBe(0);
    await page.getByRole("button", { name: "Start this attempt", exact: true }).click();

    await expect(page.getByText("Attempt started")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Continue this attempt in Canvas" })).toBeVisible();
    await expect(page.getByText(/active attempt is preserved/i)).toBeVisible();
    expect(starts).toBe(1);
    await expect(page.getByRole("button", { name: /Start|Submit/ })).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    const continuation = page.getByRole("link", { name: "Continue attempt in Canvas" });
    await expect(continuation).toHaveAttribute("href", canvasUrl);
    await expect(continuation).toHaveAttribute("target", "_blank");
    await expect(continuation).toHaveAttribute("rel", /noopener/);
  });

  test("resume failure never falls back to a new attempt", async ({ page }) => {
    let posts = 0;
    await page.route(`**/api/canvas/quizzes/${quizId}/preflight`, async route => {
      await route.fulfill({ json: { quiz: { ...quiz, status: "in_progress" }, availability: { canStart: false, status: "in_progress" }, attempts: { used: 1, remaining: 1 }, activeAttempt: { id: "901", attempt: 1, state: "untaken" } } });
    });
    await page.route(`**${attemptPath}`, async route => {
      if (route.request().method() === "POST") posts += 1;
      await route.fulfill({ status: 503, json: { error: "Canvas is temporarily unavailable" } });
    });
    await page.goto(quizPath);
    await expect(page.getByRole("alert")).toContainText("No new attempt will be started");
    await expect(page.getByRole("button", { name: "Retry resume" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start quiz" })).toHaveCount(0);
    expect(posts).toBe(0);
  });

  test("is responsive, focus-contained, and still under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(`**/api/canvas/quizzes/${quizId}/preflight`, async route => {
      await route.fulfill({ json: { quiz, availability: { canStart: true, status: "available" }, attempts: { used: 0, remaining: 2 } } });
    });
    await page.route(`**${attemptPath}`, async route => {
      await route.fulfill({ json: active });
    });
    await page.goto(quizPath);
    await page.getByRole("button", { name: "Start quiz" }).click();
    const dialog = page.getByRole("dialog", { name: "Start this attempt?" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Go back" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Start this attempt", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "Start quiz" }).click();
    await page.getByRole("button", { name: "Start this attempt", exact: true }).click();
    await page.getByRole("button", { name: "Review answers" }).click();
    const continueButton = page.getByRole("button", { name: "Continue to submit" });
    await continueButton.focus();
    await page.waitForTimeout(1_100);
    await expect(continueButton).toBeFocused();
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      running: document.getAnimations().filter(animation => animation.playState === "running").length,
    }));
    expect(state.overflow).toBeLessThanOrEqual(1);
    expect(state.running).toBe(0);
  });
});

test("canonical Quiz Mode stays protected without an authenticated Clerk session", async ({ page }) => {
  const apiResponse = await page.request.get(`/api/canvas/quizzes/${quizId}/preflight`);
  expect(apiResponse.status()).toBe(401);
  const body = await apiResponse.json();
  expect(body).toMatchObject({ code: "AUTH_REQUIRED" });
  expect(JSON.stringify(body)).not.toMatch(/stack|postgres|cookie|validation_token|secret/i);

  await page.goto(quizPath);
  await expect(page).toHaveURL(/\/sign-in(?:\?|\/|$)/);
  await expect(page.getByText(/Application error/i)).toHaveCount(0);
});
