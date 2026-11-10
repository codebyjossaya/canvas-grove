import { expect, test } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

test.beforeEach(async ({ context }) => {
  await setupClerkTestingToken({ context });
});

test("signed-out landing and Google OAuth initiation are healthy", async ({ page }) => {
  let handshakes = 0;
  page.on("request", request => {
    if (request.url().includes("__clerk_handshake")) handshakes += 1;
  });
  await page.goto("/");
  await expect(page.getByText("Everything in Canvas.")).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).first().click();
  const google = page.getByRole("button", { name: /google/i }).first();
  await expect(google).toBeVisible();
  await google.click();
  await page.waitForURL(url => url.hostname === "accounts.google.com");
  expect(handshakes).toBeLessThanOrEqual(2);
});

test("protected routes and session APIs do not expose data while signed out", async ({ page, request }) => {
  const protectedResponse = await page.goto("/courses");
  expect(protectedResponse?.headers()["x-clerk-auth-status"]).toBe("signed-out");
  await expect(page.getByRole("heading", { name: "Your courses." })).toHaveCount(0);

  for (const path of ["/api/canvas/sessions", "/api/canvas/sync/status"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"]).toContain("application/json");
    const payload = await response.json();
    expect(payload.error).toBe("Authentication required");
    expect(typeof payload.code).toBe("string");
    expect(JSON.stringify(payload)).not.toMatch(/postgres|docker|orchestrator|stack|ECONN/i);
  }
});

test("gateway blocks private endpoints and keeps invalid live grants closed", async ({ request }) => {
  await expect((await request.get("/v1/sessions")).status()).toBe(404);
  await expect((await request.get("/health")).status()).toBe(404);
  await expect((await request.get("/live/not-a-valid-token")).status()).toBe(410);
  await expect((await request.get("/viewer/00000000-0000-0000-0000-000000000000/vnc.html")).status()).toBe(401);
});
