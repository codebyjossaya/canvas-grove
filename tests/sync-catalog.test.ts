import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs, deterministicJitterMs, isAssignmentEvent, primaryRequest, syncPolicies } from "../lib/sync/catalog";

test("continuous sync policies have bounded freshness and deterministic jitter", () => {
  for (const [kind, policy] of Object.entries(syncPolicies)) {
    assert.ok(policy.intervalMs > 0, kind);
    assert.ok(policy.staleAfterMs >= policy.intervalMs, kind);
    const first = deterministicJitterMs("account-portability", kind as keyof typeof syncPolicies);
    assert.equal(first, deterministicJitterMs("account-portability", kind as keyof typeof syncPolicies));
    assert.ok(Math.abs(first) <= policy.intervalMs * 0.15 + 1, kind);
    const request = primaryRequest(kind as keyof typeof syncPolicies);
    assert.equal(request.method, "GET");
    assert.match(request.path, /^\/api\/v1\//);
  }
});

test("retry backoff grows and remains capped", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(backoffMs), [60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
});

test("inbox sync fetches every inbox thread, not an always-empty filter", () => {
  // Canvas `filter[]` takes context codes (course_123), so `filter[]=unread` matched nothing
  // and the Inbox never synced a single thread.
  const { path } = primaryRequest("inbox");
  assert.match(path, /^\/api\/v1\/conversations\?scope=inbox&/);
  assert.doesNotMatch(path, /filter/);
});

test("only assignment rows from upcoming_events are treated as assignments", () => {
  assert.equal(isAssignmentEvent({ type: "assignment", id: "assignment_7", assignment: { id: 7 } }), true);
  assert.equal(isAssignmentEvent({ type: "event", id: 4096470, title: "Office hours" }), false);
  assert.equal(isAssignmentEvent({ assignment: { id: 7 } }), true);
  assert.equal(isAssignmentEvent({ id: 4096470 }), false);
});

