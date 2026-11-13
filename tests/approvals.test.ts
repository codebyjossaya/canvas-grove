import assert from "node:assert/strict";
import test from "node:test";
import { canEnable, capState, confirmationLines, autoActive, expiringSoon, durationLabel, DURATIONS } from "../components/workspace/approvals/auto-model";
import { fixtureAutoTargets, fixtureAwaiting, fixtureHistory } from "../components/workspace/approvals/fixtures";
import { CATEGORIES, DEFAULT_CATEGORIES, badgeFor, classifyDecisionStatus, consequenceFor, formatRemaining, indexAfterRemoval, moveIndex, quizConsequence, timeLeft } from "../components/workspace/approvals/model";

const NOW = Date.parse("2026-11-13T12:00:00Z");

test("no category is preselected and the three contract categories exist", () => {
  assert.deepEqual(DEFAULT_CATEGORIES, []);
  assert.deepEqual(CATEGORIES.map(c => c.id).sort(), ["outward_messages", "quiz_entry", "submit_assignment"]);
  assert.equal(canEnable([]), false);
  assert.equal(canEnable(["quiz_entry"]), true);
});

test("quiz entry shows the exact plain-language consequence", () => {
  const quiz = fixtureAwaiting(NOW).find(a => a.category === "quiz_entry")!;
  assert.equal(consequenceFor(quiz), "Let Claude take this graded quiz: it can read the questions, answer them and submit this attempt.");
  assert.equal(quizConsequence("Cursor"), "Let Cursor take this quiz: it can read the questions, answer them and submit this attempt.");
  assert.match(quiz.preview.warning ?? "", /graded Canvas assessment[\s\S]*affect your course grade/);
  const other = fixtureAwaiting(NOW).find(a => a.category === "submit_assignment")!;
  assert.match(consequenceFor(other), /^Claude Code wants to: /);
});

test("time left and remaining formatting", () => {
  assert.equal(formatRemaining(59 * 60_000), "59 min");
  assert.equal(formatRemaining(60 * 60_000), "1 h");
  assert.equal(formatRemaining(7 * 3_600_000 + 59 * 60_000), "7 h 59 min");
  assert.equal(formatRemaining(26 * 3_600_000), "1 d 2 h");
  assert.deepEqual(timeLeft(new Date(NOW + 3 * 60_000).toISOString(), NOW), { expired: false, urgent: true, label: "3 min left" });
  assert.deepEqual(timeLeft(new Date(NOW + 20 * 60_000).toISOString(), NOW), { expired: false, urgent: false, label: "20 min left" });
  assert.equal(timeLeft(new Date(NOW - 1).toISOString(), NOW).expired, true);
});

test("history badges: You, Auto, Expired", () => {
  const history = fixtureHistory(NOW);
  const by = (id: string) => badgeFor(history.find(a => a.id === id)!).text;
  assert.equal(by("h1"), "You");
  assert.equal(by("h2"), "Auto");
  assert.equal(by("h5"), "Expired");
});

test("409 and 410 map to already decided and expired", () => {
  assert.equal(classifyDecisionStatus(409), "already_decided");
  assert.equal(classifyDecisionStatus(410), "expired");
  assert.equal(classifyDecisionStatus(500), "error");
  assert.equal(classifyDecisionStatus(401), "error");
});

test("keyboard index movement clamps and handles empty lists", () => {
  assert.equal(moveIndex(-1, 1, 3), 0);
  assert.equal(moveIndex(-1, -1, 3), 2);
  assert.equal(moveIndex(2, 1, 3), 2);
  assert.equal(moveIndex(0, -1, 3), 0);
  assert.equal(moveIndex(0, 1, 0), -1);
  assert.equal(indexAfterRemoval(0, 3), 0);
  assert.equal(indexAfterRemoval(2, 3), 1);
  assert.equal(indexAfterRemoval(0, 1), -1);
});

test("auto mode: caps, expiry, active state", () => {
  const targets = (s: Parameters<typeof fixtureAutoTargets>[1]) => fixtureAutoTargets(NOW, s)[0].auto;
  assert.equal(autoActive(targets("off"), NOW), false);
  assert.equal(autoActive(targets("on"), NOW), true);
  assert.equal(autoActive({ ...targets("on"), expiresAt: new Date(NOW - 1000).toISOString() }, NOW), false);
  assert.equal(autoActive({ ...targets("on"), expiresAt: null }, NOW), true);
  assert.equal(capState(targets("capped")).hourly, true);
  assert.equal(capState({ ...targets("on"), usedToday: 200 }).daily, true);
  assert.equal(capState(targets("on")).any, false);
  assert.equal(expiringSoon(targets("expiring"), NOW), true);
  assert.equal(expiringSoon(targets("on"), NOW), false);
  assert.equal(fixtureAutoTargets(NOW, "readonly").every(t => !t.canPropose), true);
});

test("confirmation spells out what happens without asking, limits and graded quiz impact", () => {
  const lines = confirmationLines("Claude", ["submit_assignment", "quiz_entry"], 480);
  assert.match(lines.intro, /Claude can do these things without asking you first/);
  assert.equal(lines.does.length, 2);
  assert.ok(lines.limits.some(l => l.includes("8 hours")));
  assert.ok(lines.limits.some(l => /30 actions per hour and 200 per day/.test(l)));
  assert.ok(lines.limits.some(l => /includes graded quizzes and graded surveys[\s\S]*affect your course grade/.test(l)));
  assert.ok(confirmationLines("X", ["quiz_entry"], null).limits[0].includes("until you turn it off"));
  assert.deepEqual(DURATIONS.map(d => d.minutes), [60, 480, 1440, null]);
  assert.equal(durationLabel(1440), "24 hours");
});
