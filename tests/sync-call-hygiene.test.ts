import assert from "node:assert/strict";
import test from "node:test";
import { endpointTemplate, hygienic, resetCallHygiene } from "../lib/sync/executor";
import type { CanvasApi } from "../lib/canvas/session-client";

const reply = (status: number, extra: Record<string, unknown> = {}) => ({ ok: status < 300, status, authRequired: false, hasLinkHeader: false, ...extra });
function fake(responses: Record<string, ReturnType<typeof reply>>) {
  const seen: string[] = [];
  const api: CanvasApi = { async request(request) { seen.push(request.path); return responses[request.path.split("?")[0]] ?? reply(200); } };
  return { api, seen };
}

test("endpointTemplate strips ids and query", () => {
  assert.equal(endpointTemplate("/api/v1/courses/12/files?per_page=100"), "/api/v1/courses/:id/files");
  assert.equal(endpointTemplate("/api/v1/courses/12/pages/some-slug"), "/api/v1/courses/:id/pages/:slug");
});

test("permanent 403/404 course endpoints are not re-requested within the TTL, 200s and other owners are", async () => {
  resetCallHygiene();
  const { api, seen } = fake({ "/api/v1/courses/1/files": reply(403), "/api/v1/courses/1/pages": reply(404) });
  let t = 0;
  const first = hygienic(api, "owner-a", { now: () => t });
  assert.equal((await first.api.request({ method: "GET", path: "/api/v1/courses/1/files?per_page=100" })).status, 403);
  await first.api.request({ method: "GET", path: "/api/v1/courses/1/pages?per_page=100" });
  await first.api.request({ method: "GET", path: "/api/v1/courses/1/tabs" });
  assert.deepEqual(first.breakdown, { "403 /api/v1/courses/:id/files": 1, "404 /api/v1/courses/:id/pages": 1 });
  t = 60_000;
  const second = hygienic(api, "owner-a", { now: () => t });
  const skipped = await second.api.request({ method: "GET", path: "/api/v1/courses/1/files?per_page=100" });
  assert.equal(skipped.status, 403);
  await second.api.request({ method: "GET", path: "/api/v1/courses/1/tabs" });
  assert.equal(seen.filter((path) => path.includes("/files")).length, 1);
  assert.equal(seen.filter((path) => path.includes("/tabs")).length, 2);
  await hygienic(api, "owner-b", { now: () => t }).api.request({ method: "GET", path: "/api/v1/courses/1/files" });
  assert.equal(seen.filter((path) => path.includes("/files")).length, 2);
  t = 7 * 60 * 60_000;
  await hygienic(api, "owner-a", { now: () => t }).api.request({ method: "GET", path: "/api/v1/courses/1/files" });
  assert.equal(seen.filter((path) => path.includes("/files")).length, 3);
});

test("429 and a low rate-limit quota pause the next request for the owner", async () => {
  resetCallHygiene();
  const waits: number[] = [];
  const { api } = fake({ "/api/v1/courses/1/tabs": reply(429, { retryAfterSeconds: 7 }), "/api/v1/courses/2/tabs": reply(200, { rateLimitRemaining: 5 }) });
  let t = 0;
  const wrapped = hygienic(api, "o", { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } }).api;
  await wrapped.request({ method: "GET", path: "/api/v1/courses/1/tabs" });
  await wrapped.request({ method: "GET", path: "/api/v1/courses/2/tabs" });
  await wrapped.request({ method: "GET", path: "/api/v1/courses/3/tabs" });
  assert.deepEqual(waits, [7000, 1000]);
});
