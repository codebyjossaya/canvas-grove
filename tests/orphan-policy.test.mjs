import assert from "node:assert/strict";
import test from "node:test";
import { classifyManagedContainer } from "../services/browser-orchestrator/orphan-policy.mjs";

const owned = "11111111-1111-4111-8111-111111111111";
const orphan = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-11-09T12:00:00Z");
const input = { registryNames: new Set(["canvas-browser-warm-33333333-3333-4333-8333-333333333333"]), ownedSessionIds: [owned], now, graceMs: 600_000 };

test("orphan reconciliation protects registry and database ownership", () => {
  assert.equal(classifyManagedContainer({ ...input, name: `canvas-browser-${owned}`, createdAt: "2020-01-01T00:00:00Z" }), "protected");
  assert.equal(classifyManagedContainer({ ...input, name: "canvas-browser-warm-33333333-3333-4333-8333-333333333333", createdAt: "2020-01-01T00:00:00Z" }), "protected");
});

test("orphan reconciliation quarantines young/ambiguous and removes only expired unowned", () => {
  assert.equal(classifyManagedContainer({ ...input, name: `canvas-browser-${orphan}`, createdAt: "2026-11-09T11:55:01Z" }), "quarantined");
  assert.equal(classifyManagedContainer({ ...input, name: `canvas-browser-${orphan}`, createdAt: "not-a-date" }), "quarantined");
  assert.equal(classifyManagedContainer({ ...input, name: `canvas-browser-${orphan}`, createdAt: "2026-11-09T11:40:00Z" }), "remove");
});

test("reconciliation decisions are retry-idempotent", () => {
  const candidate = { ...input, name: `canvas-browser-${orphan}`, createdAt: "2026-11-09T11:40:00Z" };
  assert.equal(classifyManagedContainer(candidate), classifyManagedContainer(candidate));
});
