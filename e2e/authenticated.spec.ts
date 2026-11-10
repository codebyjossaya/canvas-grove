import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context, page }) => {
  await setupClerkTestingToken({ context });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });
});

test("onboarding completion is durable, idempotent, and replayable", async ({ page }) => {
  const before = await page.request.get("/api/onboarding");
  expect(before.status()).toBe(200);

  const first = await page.request.post("/api/onboarding", { data: { completed: true } });
  expect(first.status()).toBe(200);
  const firstValue = await first.json();
  expect(firstValue).toMatchObject({ completed: true });
  expect(firstValue.completedAt).toEqual(expect.any(String));

  const repeated = await page.request.post("/api/onboarding", { data: { completed: true } });
  expect(repeated.status()).toBe(200);
  expect((await repeated.json()).completedAt).toBe(firstValue.completedAt);

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await page.goto("/welcome?replay=1");
  await expect(page).toHaveURL(/\/welcome\?replay=1$/);
  await expect(page.getByText(/offline/i)).toHaveCount(0);

  const afterReplay = await page.request.get("/api/onboarding");
  expect((await afterReplay.json()).completedAt).toBe(firstValue.completedAt);
});

test("authenticated APIs return sanitized envelopes", async ({ page }) => {
  for (const path of ["/api/canvas/sessions", "/api/canvas/sync/status"]) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/postgres|stack trace|ECONN|docker\.sock/i);
  }

  const absent = await page.request.get("/api/canvas/sessions/00000000-0000-0000-0000-000000000000");
  expect([400, 404]).toContain(absent.status());
  expect(JSON.stringify(await absent.json())).not.toMatch(/postgres|stack trace|ECONN|docker\.sock/i);
});

test("every authenticated route renders its persisted Canvas records", async ({ page }) => {
  const routes = [
    { path: "/", heading: "Your academic day.", records: ".course-card" },
    { path: "/planner", heading: "Plan the work.", records: ".timeline-list article" },
    { path: "/courses", heading: "Your courses.", records: ".course-card" },
    { path: "/inbox", heading: "Canvas conversations.", records: ".announcement-list article" },
    { path: "/settings", heading: "Connection, sync & privacy.", records: ".session-card" },
  ];
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page).toHaveURL(new RegExp(`${route.path === "/" ? "/?$" : `${route.path}$`}`));
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.locator(route.records).first()).toBeVisible();
    await expect(page.locator("text=Application error")).toHaveCount(0);
  }
});

test("deployed Check connection performs a provider verification and reports its result", async ({ page }) => {
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "Check connection" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText(/Connection verified at/)).toBeVisible({ timeout: 35_000 });
  await expect(button).toBeEnabled();
});
