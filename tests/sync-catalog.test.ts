import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs, deterministicJitterMs, primaryRequest, syncPolicies } from "../lib/sync/catalog";

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
