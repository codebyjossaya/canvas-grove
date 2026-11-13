import { test } from "node:test";
import assert from "node:assert/strict";
import { autoActive, autoDecision, parseAutoInput, quizClassification, quizEligibility, sessionAllows, sessionExpiry, type QuizFacts } from "../lib/mcp/action-policy";
import { AUTO_CAPS, AUTO_CATEGORIES, AUTO_DURATIONS, DEFAULT_AUTO_CATEGORIES, TOOL_CATEGORY, canPropose } from "../lib/mcp/categories";
import { grantedScopes } from "../lib/mcp/oauth-policy";

const flags = { requireLockdownBrowser: false, requireLockdownMonitor: false, accessCodeRequired: false, ipRestricted: false, oneQuestionAtATime: false, cantGoBack: false };
const practice: QuizFacts = { engine: "classic", quiz_type: "practice_quiz", points_possible: "10", supported: true, title: "Practice Quiz 1", description_html: "<p>Warm-up</p>", source_payload: flags };
const quiz = (over: Partial<QuizFacts>): QuizFacts => ({ ...practice, ...over });

test("eligibility covers all four Canvas Classic Quiz modes regardless of points", () => {
  const supported: Array<[string, Partial<QuizFacts>]> = [
    ["practice/ungraded", { quiz_type: "practice_quiz", points_possible: "10" }],
    ["non-practice/graded", { quiz_type: "assignment", points_possible: "25" }],
    ["non-practice/ungraded", { quiz_type: "survey", points_possible: "0" }],
    ["non-practice/graded survey", { quiz_type: "graded_survey", points_possible: null }],
  ];
  for (const [label, facts] of supported) assert.deepEqual(quizEligibility(quiz(facts)), { eligible: true }, label);
  assert.deepEqual(quizClassification("practice_quiz"), { assessmentKind: "practice_quiz", practice: true, graded: false, label: "Practice quiz (ungraded)" });
  assert.deepEqual(quizClassification("assignment"), { assessmentKind: "graded_quiz", practice: false, graded: true, label: "Graded quiz" });
  assert.deepEqual(quizClassification("survey"), { assessmentKind: "survey", practice: false, graded: false, label: "Survey (ungraded)" });
  assert.deepEqual(quizClassification("graded_survey"), { assessmentKind: "graded_survey", practice: false, graded: true, label: "Graded survey" });
  assert.equal(quizClassification(null).graded, null);
});

test("eligibility refuses only technically unsupported/restricted and unknown quizzes (fail closed)", () => {
  const refused: Array<[string, QuizFacts | null]> = [
    ["unknown type", quiz({ quiz_type: null })],
    ["new quiz", quiz({ engine: "new_quiz" })],
    ["engine unknown", quiz({ engine: null })],
    ["lockdown browser", quiz({ source_payload: { ...flags, requireLockdownBrowser: true } })],
    ["lockdown monitor", quiz({ source_payload: { ...flags, requireLockdownMonitor: true } })],
    ["access code", quiz({ source_payload: { ...flags, accessCodeRequired: true } })],
    ["ip filter", quiz({ source_payload: { ...flags, ipRestricted: true } })],
    ["honorlock title", quiz({ title: "Exam 2 Honorlock Check" })],
    ["proctored description", quiz({ description_html: "<p>This quiz is proctored by Respondus</p>" })],
    ["restriction flags missing", quiz({ source_payload: { oneQuestionAtATime: true } })],
    ["no source payload", quiz({ source_payload: null })],
    ["unsupported natively", quiz({ supported: false })],
    ["support unknown", quiz({ supported: null })],
    ["deleted", quiz({ deleted_at: new Date().toISOString() })],
    ["missing", null],
  ];
  for (const [label, facts] of refused) {
    const result = quizEligibility(facts);
    assert.equal(result.eligible, false, label);
    assert.ok(!result.eligible && result.code === "QUIZ_NOT_ELIGIBLE" && result.reason.length > 0, label);
  }
});

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

test("auto mode: off by default, category-scoped, time-boxed and capped", () => {
  assert.deepEqual(DEFAULT_AUTO_CATEGORIES, []);
  assert.deepEqual(autoDecision(null, "quiz_entry", 0, 0), { auto: false, reason: "off" });
  assert.deepEqual(autoDecision({ enabled: false, categories: ["quiz_entry"], expires_at: future() }, "quiz_entry", 0, 0), { auto: false, reason: "off" });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["quiz_entry"], expires_at: future() }, "quiz_entry", 0, 0), { auto: true });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["quiz_entry"], expires_at: null }, "quiz_entry", 0, 0), { auto: true });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["quiz_entry"], expires_at: past() }, "quiz_entry", 0, 0), { auto: false, reason: "expired" });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["submit_assignment"], expires_at: future() }, "quiz_entry", 0, 0), { auto: false, reason: "category" });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["quiz_entry"], expires_at: future() }, "quiz_entry", AUTO_CAPS.perHour, 0), { auto: false, reason: "hour_cap" });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["quiz_entry"], expires_at: future() }, "quiz_entry", 0, AUTO_CAPS.perDay), { auto: false, reason: "day_cap" });
  assert.deepEqual(autoDecision({ enabled: true, categories: ["quiz_entry"], expires_at: future() }, null, 0, 0), { auto: false, reason: "no_category" });
  assert.equal(autoActive({ enabled: true, categories: [], expires_at: past() }), false);
  assert.equal(TOOL_CATEGORY.start_quiz_attempt, "quiz_entry");
  assert.equal(TOOL_CATEGORY.save_planner_note, undefined);
  assert.deepEqual([...AUTO_DURATIONS], [60, 480, 1440, null]);
  assert.deepEqual([...AUTO_CATEGORIES], ["submit_assignment", "outward_messages", "quiz_entry"]);
});

test("auto-mode settings input validation", () => {
  assert.deepEqual(parseAutoInput({ enabled: true, categories: ["quiz_entry"], durationMinutes: 480 }), { ok: true, value: { enabled: true, categories: ["quiz_entry"], durationMinutes: 480 } });
  assert.deepEqual(parseAutoInput({ enabled: false }), { ok: true, value: { enabled: false, categories: [], durationMinutes: 60 } });
  assert.ok(parseAutoInput({ enabled: true, categories: ["quiz_entry"], durationMinutes: null }).ok);
  for (const bad of [null, [], { enabled: "yes" }, { enabled: true, categories: [] }, { enabled: true, categories: ["everything"] }, { enabled: true, categories: ["quiz_entry"], durationMinutes: 5 }])
    assert.equal(parseAutoInput(bad).ok, false, JSON.stringify(bad));
});

test("quiz sessions are bound to one quiz and one Canvas attempt, and expire", () => {
  const session = { quiz_id: "q1", canvas_submission_id: "555", attempt: 3, expires_at: future(), ended_at: null };
  assert.deepEqual(sessionAllows(session, "q1", { submissionId: "555", attempt: 3 }), { ok: true });
  assert.equal(sessionAllows(session, "q2").ok, false);
  const other = sessionAllows(session, "q1", { submissionId: "555", attempt: 4 });
  assert.ok(!other.ok && other.code === "QUIZ_SESSION_ATTEMPT_MISMATCH");
  assert.equal(sessionAllows(session, "q1", { submissionId: "556", attempt: 3 }).ok, false);
  assert.equal(sessionAllows({ ...session, ended_at: past() }, "q1").ok, false);
  assert.equal(sessionAllows({ ...session, expires_at: past() }, "q1").ok, false);
  assert.equal(sessionAllows(null, "q1").ok, false);
  const now = Date.now();
  assert.equal(sessionExpiry(null, now).getTime(), now + 120 * 60_000);
  assert.equal(sessionExpiry(new Date(now + 10 * 60_000).toISOString(), now).getTime(), now + 10 * 60_000);
  assert.equal(sessionExpiry(new Date(now + 5 * 3600_000).toISOString(), now).getTime(), now + 120 * 60_000);
});

test("write scope: proposing needs canvas:write; consent grants it only when offered and ticked", () => {
  assert.equal(canPropose(["canvas:read"]), false);
  assert.equal(canPropose(["canvas:read", "canvas:write"]), true);
  assert.deepEqual(grantedScopes(true, false), ["canvas:read"]);
  assert.deepEqual(grantedScopes(false, true), ["canvas:read"]);
  assert.deepEqual(grantedScopes(true, true), ["canvas:read", "canvas:write"]);
});
