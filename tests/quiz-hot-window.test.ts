import assert from "node:assert/strict";
import test from "node:test";
import { isQuizHot } from "../lib/sync/catalog";

const now = Date.parse("2026-11-17T20:00:00Z");
const m = (min: number) => new Date(now + min * 60_000);

test("attendance quiz (no due date) is hot before and during its unlock window", () => {
  assert.equal(isQuizHot({ unlockAt: m(30), lockAt: m(36) }, now), true);
  assert.equal(isQuizHot({ unlockAt: m(-2), lockAt: m(3) }, now), true);
});
test("attendance quiz is not hot far ahead or after lock", () => {
  assert.equal(isQuizHot({ unlockAt: m(60 * 24), lockAt: m(60 * 24 + 5) }, now), false);
  assert.equal(isQuizHot({ unlockAt: m(-10), lockAt: m(-5) }, now), false);
});
test("due-date behaviour is preserved; undated open-ended quiz is not hot", () => {
  assert.equal(isQuizHot({ dueAt: m(90) }, now), true);
  assert.equal(isQuizHot({ dueAt: m(300) }, now), false);
  assert.equal(isQuizHot({ unlockAt: m(-1000) }, now), false);
});
