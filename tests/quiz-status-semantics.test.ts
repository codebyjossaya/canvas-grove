import assert from "node:assert/strict";
import test from "node:test";
import { deriveQuizStatus, type QuizStatusInput } from "../lib/quizzes/contracts";

const now = Date.parse("2026-11-08T12:00:00Z");
const base: QuizStatusInput = {
  supported: true, published: true, lockedForUser: false, active: false, completed: false,
  attempt: 0, extraAttempts: 0, allowedAttempts: 1, now,
};
const status = (patch: Partial<QuizStatusInput>) => deriveQuizStatus({ ...base, ...patch });

test("an active Canvas attempt is always actionable and resumable", () => {
  const value = status({ active: true, attempt: 1, dueAt: now - 1, lockAt: now - 1 });
  assert.equal(value.status, "in_progress");
  assert.equal(value.actionable, true);
  assert.equal(value.canStart, false);
});

test("a completed single-attempt quiz goes to history", () => {
  const value = status({ completed: true, completedAt: "2026-11-08T10:00:00Z", attempt: 1 });
  assert.equal(value.status, "completed");
  assert.equal(value.actionable, false);
  assert.equal(value.attemptsRemaining, 0);
});

test("a completed unlimited quiz remains available as an explicit retake", () => {
  const value = status({ completed: true, attempt: 3, allowedAttempts: -1 });
  assert.equal(value.status, "available");
  assert.equal(value.actionable, true);
  assert.equal(value.retakeAllowed, true);
  assert.equal(value.attemptsUnlimited, true);
  assert.equal(value.attemptsRemaining, null);
});

test("unknown attempt limits are distinct from unlimited", () => {
  const value = status({ allowedAttempts: null });
  assert.equal(value.attemptsKnown, false);
  assert.equal(value.attemptsUnlimited, false);
  assert.equal(value.attemptsRemaining, null);
});

test("overdue available quizzes are history-like but still permit an intentional late start", () => {
  const value = status({ dueAt: now - 1 });
  assert.equal(value.status, "past_due");
  assert.equal(value.actionable, false);
  assert.equal(value.canStart, true);
});

test("overdue locked quizzes cannot start", () => {
  const value = status({ dueAt: now - 10, lockAt: now - 1 });
  assert.equal(value.status, "locked");
  assert.equal(value.canStart, false);
});

test("future and undated quizzes have deterministic actionable states", () => {
  assert.equal(status({ unlockAt: now + 60_000 }).status, "upcoming");
  assert.equal(status({ unlockAt: now + 60_000 }).actionable, true);
  assert.equal(status({ dueAt: null, unlockAt: null, lockAt: null }).status, "available");
});

test("attempt exhaustion without a completed receipt is explicit", () => {
  const value = status({ attempt: 1, allowedAttempts: 1 });
  assert.equal(value.status, "attempts_exhausted");
  assert.equal(value.actionable, false);
});

test("unsupported quizzes never enter the actionable feed", () => {
  const value = status({ supported: false, unsupportedReason: "Proctored" });
  assert.equal(value.status, "unsupported");
  assert.equal(value.actionable, false);
});

test("summary loading batches assignment submissions and deduplicates assignment-backed quizzes", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8"));
  assert.match(source, /assignments\?include\[\]=submission&per_page=100&page=/);
  assert.match(source, /new Map<string, \(typeof listed\)\[number\]>/);
  assert.match(source, /row\.canvasAssignmentId/);
  assert.match(source, /statusStale/);
});
