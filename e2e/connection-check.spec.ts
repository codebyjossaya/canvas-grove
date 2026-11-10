import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

const session = { id: "11111111-1111-4111-8111-111111111111", canvasOrigin: "https://school.instructure.com", institutionName: "Example University", state: "active", updatedAt: new Date().toISOString() };

test.beforeEach(async ({ context, page }) => {
  await setupClerkTestingToken({ context });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });
});

test("Check connection reports verified success and supports a later repeat", async ({ page }) => {
  let checks = 0;
  await page.route("**/api/canvas/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(session.id) && url.searchParams.get("verify") === "1") { checks += 1; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session }) }); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session] }) });
  });
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "Check connection" });
  await button.click();
  await expect(page.getByText(/Connection verified at/)).toBeVisible();
  await button.click();
  await expect.poll(() => checks).toBe(2);
});

test("Check connection reports provider failure instead of silently succeeding", async ({ page }) => {
  await page.route("**/api/canvas/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(session.id) && url.searchParams.get("verify") === "1") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "BROWSER_HOST_OFFLINE", error: "Browser host unavailable" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session] }) });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByText(/browser host/i)).toBeVisible();
  await expect(page.getByText(/Connection verified at/)).toHaveCount(0);
});

test("rapid repeated clicks coalesce into one provider check", async ({ page }) => {
  let checks = 0;
  await page.route("**/api/canvas/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(session.id) && url.searchParams.get("verify") === "1") { checks += 1; await new Promise((resolve) => setTimeout(resolve, 300)); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session }) }); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session] }) });
  });
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "Check connection" });
  await button.dblclick({ delay: 20 }).catch(() => undefined);
  await expect(page.getByText(/Connection verified at/)).toBeVisible();
  expect(checks).toBe(1);
});
