import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkRateLimit, rateLimitedResponse, resetRateLimits, RATE_LIMITS } from "../lib/rate-limit";

const policy = { name: "t", limit: 3, windowMs: 60_000 };

test("allows up to the limit, then blocks with Retry-After", () => {
  resetRateLimits();
  for (let i = 0; i < 3; i += 1) assert.equal(checkRateLimit(policy, "u1", 1_000 + i).allowed, true);
  const blocked = checkRateLimit(policy, "u1", 2_000);
  assert.equal(blocked.allowed, false);
  assert.ok(!blocked.allowed && blocked.retryAfterSeconds >= 58 && blocked.retryAfterSeconds <= 60);
});

test("limits are per user and per policy", () => {
  resetRateLimits();
  for (let i = 0; i < 3; i += 1) checkRateLimit(policy, "u1", 1_000);
  assert.equal(checkRateLimit(policy, "u1", 1_000).allowed, false);
  assert.equal(checkRateLimit(policy, "u2", 1_000).allowed, true);
  assert.equal(checkRateLimit({ ...policy, name: "other" }, "u1", 1_000).allowed, true);
});

test("window slides: old hits expire", () => {
  resetRateLimits();
  for (let i = 0; i < 3; i += 1) checkRateLimit(policy, "u1", 0);
  assert.equal(checkRateLimit(policy, "u1", 59_999).allowed, false);
  assert.equal(checkRateLimit(policy, "u1", 60_001).allowed, true);
});

test("blocked requests do not extend the window", () => {
  resetRateLimits();
  for (let i = 0; i < 3; i += 1) checkRateLimit(policy, "u1", 0);
  for (let t = 1; t < 50; t += 1) checkRateLimit(policy, "u1", t * 1_000);
  assert.equal(checkRateLimit(policy, "u1", 60_001).allowed, true);
});

test("429 response shape", async () => {
  const response = rateLimitedResponse(42);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.equal((await response.json()).code, "RATE_LIMITED");
});

test("outbound-fetching routes check the limit before doing work", () => {
  const search = readFileSync(new URL("../app/api/canvas/institutions/search/route.ts", import.meta.url), "utf8");
  const sessions = readFileSync(new URL("../app/api/canvas/sessions/route.ts", import.meta.url), "utf8");
  assert.ok(search.indexOf("RATE_LIMITS.institutionSearch") < search.indexOf("searchCanvasInstitutions("));
  const post = sessions.slice(sessions.indexOf("export async function POST"));
  assert.ok(post.indexOf("RATE_LIMITS.sessionCreate") > 0 && post.indexOf("RATE_LIMITS.sessionCreate") < post.indexOf("discoverInstitutionHosts("));
  assert.ok(RATE_LIMITS.sessionCreate.limit >= 3, "must leave room for normal retries");
});
