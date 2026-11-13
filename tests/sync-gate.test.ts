import assert from "node:assert/strict";
import test from "node:test";
import { SweepLedger, attemptOpen, courseConcluded, fingerprint, quizTier } from "../lib/sync/gate";
import { executeCanvasSyncJob } from "../lib/sync/executor";
import { resetCallHygiene } from "../lib/sync/executor";
import type { CanvasApi } from "../lib/canvas/session-client";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

test("courseConcluded uses workflow state and course/term end dates", () => {
  assert.equal(courseConcluded({ workflow_state: "completed" }, NOW), true);
  assert.equal(courseConcluded({ term: { end_at: iso(-60) } }, NOW), true);
  assert.equal(courseConcluded({ end_at: iso(60), term: { end_at: iso(600) } }, NOW), false);
  assert.equal(courseConcluded({ workflow_state: "available" }, NOW), false);
});

test("attemptOpen: only an untaken, started, unfinished attempt inside its window counts", () => {
  assert.equal(attemptOpen({ workflow_state: "untaken", started_at: iso(-10), end_at: iso(80) }, NOW), true);
  assert.equal(attemptOpen({ workflow_state: "untaken", started_at: iso(-10) }, NOW), true);
  assert.equal(attemptOpen({ workflow_state: "untaken", started_at: iso(-60 * 24 * 150) }, NOW), false, "stale months-old attempt");
  assert.equal(attemptOpen({ workflow_state: "untaken", started_at: iso(-10), end_at: iso(-1) }, NOW), false);
  assert.equal(attemptOpen({ workflow_state: "unsubmitted", started_at: iso(-10) }, NOW), false);
  assert.equal(attemptOpen({ workflow_state: "graded" }, NOW), false);
  assert.equal(attemptOpen({ workflow_state: "untaken" }, NOW), false);
});

test("quizTier: hot near deadline or open attempt, watch for the week ahead and short windows", () => {
  assert.equal(quizTier({ due_at: iso(30) }, null, NOW), "hot");
  assert.equal(quizTier({ due_at: iso(-60 * 24 * 90) }, { workflow_state: "untaken", started_at: iso(-5) }, NOW), "hot");
  assert.equal(quizTier({ due_at: iso(60 * 24 * 3) }, null, NOW), "watch");
  assert.equal(quizTier({ unlock_at: iso(-60 * 24 * 30), lock_at: iso(-60 * 24 * 30 + 8) }, null, NOW), "watch", "attendance-style short window");
  assert.equal(quizTier({ due_at: iso(60 * 24 * 20) }, null, NOW), null);
  assert.equal(quizTier({ due_at: iso(-60 * 24) }, null, NOW), null);
});

test("fingerprint is order independent and sensitive to watched fields only", () => {
  const a = { id: 1, due_at: "x", noise: 1 }, b = { id: 2, due_at: "y" };
  assert.equal(fingerprint([a, b], ["id", "due_at"]), fingerprint([b, { ...a, noise: 2 }], ["id", "due_at"]));
  assert.notEqual(fingerprint([a, b], ["id", "due_at"]), fingerprint([a, { ...b, due_at: "z" }], ["id", "due_at"]));
});

test("ledger: first sight sweeps, then tiers set the minimum age, unchanged courses go quiet, concluded wait 12h", () => {
  const ledger = new SweepLedger();
  const H = 3_600_000;
  assert.equal(ledger.due("o", "quizzes", "1", NOW, false), true);
  ledger.record("o", "quizzes", "1", NOW, "p", "hot");
  assert.equal(ledger.due("o", "quizzes", "1", NOW + 60_000, false), true, "hot is always due");
  ledger.record("o", "quizzes", "2", NOW, "p", "watch");
  assert.equal(ledger.due("o", "quizzes", "2", NOW + 5 * 60_000, false), false);
  assert.equal(ledger.due("o", "quizzes", "2", NOW + 15 * 60_000, false), true, "15-min policy cadence still reaches watch courses");
  ledger.record("o", "quizzes", "3", NOW, "p", null);
  assert.equal(ledger.due("o", "quizzes", "3", NOW + 15 * 60_000, false), false);
  assert.equal(ledger.due("o", "quizzes", "3", NOW + H, false), true);
  ledger.record("o", "quizzes", "3", NOW + H, "p", null); ledger.record("o", "quizzes", "3", NOW + 2 * H, "p", null);
  assert.equal(ledger.tierOf("o", "quizzes", "3"), "quiet");
  assert.equal(ledger.due("o", "quizzes", "3", NOW + 3 * H, false), false);
  assert.equal(ledger.due("o", "quizzes", "3", NOW + 4 * H, false), true);
  ledger.record("o", "quizzes", "3", NOW + 4 * H, "changed", null);
  assert.equal(ledger.tierOf("o", "quizzes", "3"), "active", "a change resets to the faster tier");
  assert.equal(ledger.due("o", "quizzes", "3", NOW + 4 * H + 6 * H, true), false);
  assert.equal(ledger.due("o", "quizzes", "3", NOW + 4 * H + 12 * H, true), true);
  assert.equal(ledger.due("other", "quizzes", "3", NOW, false), true, "ledger is per owner");
});

test("quiz sync only requests due courses on the second cycle", async () => {
  resetCallHygiene();
  const paths: string[] = [];
  const course = (id: number) => ({ id, workflow_state: "available" });
  const api: CanvasApi = { async request(request) {
    paths.push(request.path);
    const ok = (data: unknown) => ({ ok: true, status: 200, authRequired: false, hasLinkHeader: false, data });
    if (request.path.startsWith("/api/v1/courses?")) return ok([course(11), course(22)]);
    if (/courses\/11\/quizzes\?/.test(request.path)) return ok([{ id: 1, due_at: new Date(Date.now() + 30 * 60_000).toISOString() }]);
    if (/courses\/22\/quizzes\?/.test(request.path)) return ok([{ id: 2, due_at: new Date(Date.now() + 86_400_000 * 40).toISOString() }]);
    if (/submission/.test(request.path)) return ok({ quiz_submissions: [] });
    return ok([]);
  } };
  const run = () => executeCanvasSyncJob({ kind: "quizzes", api, scope: "gate-test-owner" });
  await run();
  const first = paths.length; paths.length = 0;
  await run();
  assert.ok(first > paths.length);
  assert.ok(paths.some((path) => path.includes("/courses/11/")), "hot course re-swept");
  assert.ok(!paths.some((path) => path.includes("/courses/22/")), "quiet course skipped");
});

test("fast cycle re-reads submissions only for hot or previously open quizzes", async () => {
  resetCallHygiene();
  const paths: string[] = [];
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const ok = (data: unknown) => ({ ok: true, status: 200, authRequired: false, hasLinkHeader: false, data });
  const api: CanvasApi = { async request(request) {
    paths.push(request.path);
    if (request.path.startsWith("/api/v1/courses?")) return ok([{ id: 7 }]);
    if (/courses\/7\/quizzes\?/.test(request.path)) return ok([{ id: 1, due_at: soon }, { id: 2 }, { id: 3 }]);
    if (/quizzes\/3\/submission/.test(request.path)) return ok({ quiz_submissions: [{ id: 9, attempt: 1, workflow_state: "untaken", started_at: new Date(Date.now() - 60_000).toISOString() }] });
    if (/submission/.test(request.path)) return ok({ quiz_submissions: [] });
    return ok([]);
  } };
  const run = () => executeCanvasSyncJob({ kind: "quizzes", api, scope: "fast-test-owner" });
  await run();
  assert.equal(paths.filter((path) => /quizzes\/\d+\/submission/.test(path)).length, 3, "first sweep reads every submission");
  paths.length = 0;
  await run();
  const reads = paths.filter((path) => /quizzes\/\d+\/submission/.test(path));
  assert.equal(reads.length, 2, "dated quiz 1 and open-attempt quiz 3 only");
  assert.ok(!reads.some((path) => path.includes("quizzes/2/")));
});
