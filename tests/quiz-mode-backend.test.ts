import assert from "node:assert/strict";
import test from "node:test";
import { answerRequest, flagRequest, idempotencyKeyFrom, normalizeAnswer, questionHasUnsupportedMedia, restrictionReason, safeQuizHtml, sanitizeQuestion, startRequest, submitRequest, timeRequest, validateOptionAnswer } from "../lib/quizzes/contracts";

test("blocks New Quizzes and every explicit proctoring signal", () => {
  assert.match(restrictionReason({}, "new_quiz") ?? "", /New Quizzes/);
  assert.match(restrictionReason({ require_lockdown_browser: true }) ?? "", /lockdown browser/);
  assert.match(restrictionReason({ require_lockdown_browser_monitor: true }) ?? "", /lockdown browser/);
  assert.match(restrictionReason({ title: "Exam with Honorlock" }) ?? "", /proctoring/);
  assert.match(restrictionReason({ submission_types: ["external_tool"], is_quiz_assignment: true }) ?? "", /New Quizzes/);
  assert.match(restrictionReason({ access_code: true }) ?? "", /access code/);
  assert.match(restrictionReason({ ip_filter: "10.0.0.0/8" }) ?? "", /approved network/);
  assert.match(restrictionReason({ cant_go_back: true }) ?? "", /prevents returning/);
});

test("constructs only official Classic Quiz API requests", () => {
  assert.deepEqual(startRequest("12", "34"), { method: "POST", path: "/api/v1/courses/12/quizzes/34/submissions" });
  assert.equal(answerRequest("56", 2, "secret", "78", 90).path, "/api/v1/quiz_submissions/56/questions");
  assert.equal(flagRequest("56", "78", true, 2, "secret").path, "/api/v1/quiz_submissions/56/questions/78/flag");
  assert.equal(flagRequest("56", "78", false, 2, "secret").path, "/api/v1/quiz_submissions/56/questions/78/unflag");
  assert.equal(timeRequest("12", "34", "56").path, "/api/v1/courses/12/quizzes/34/submissions/56/time");
  assert.equal(submitRequest("12", "34", "56", 2, "secret").path, "/api/v1/courses/12/quizzes/34/submissions/56/complete");
});

test("accepts the standardized and rollout idempotency headers and rejects missing keys", () => {
  assert.equal(idempotencyKeyFrom(new Request("https://app.test", { headers: { "x-idempotency-key": "quiz-save:1234567890" } })), "quiz-save:1234567890");
  assert.equal(idempotencyKeyFrom(new Request("https://app.test", { headers: { "idempotency-key": "quiz-save:abcdefghij" } })), "quiz-save:abcdefghij");
  assert.throws(() => idempotencyKeyFrom(new Request("https://app.test")), /valid idempotency key/);
});

test("validates supported user-entered answer formats without selecting answers", () => {
  assert.equal(normalizeAnswer("multiple_choice_question", 11), 11);
  assert.deepEqual(normalizeAnswer("multiple_answers_question", [11, 12, 11]), [11, 12]);
  assert.equal(normalizeAnswer("short_answer_question", "mine"), "mine");
  assert.equal(normalizeAnswer("numerical_question", "12.5"), "12.5");
  assert.throws(() => normalizeAnswer("multiple_choice_question", "11"), /Choose one/);
  assert.throws(() => normalizeAnswer("file_upload_question", {}), /not safely supported/);
});

test("rejects crafted answer ids that Canvas did not return", () => {
  const question = { id: "1", position: 1, type: "multiple_choice", questionTextHtml: "", pointsPossible: 1, flagged: false, answer: null, options: [{ id: 10, textHtml: "A" }, { id: 11, textHtml: "B" }] };
  assert.doesNotThrow(() => validateOptionAnswer(question, 10));
  assert.throws(() => validateOptionAnswer(question, 999), /only answers Canvas returned/);
  assert.throws(() => validateOptionAnswer({ ...question, type: "multiple_answers" }, [10, 999]), /only answers Canvas returned/);
});

test("sanitizes question HTML and never exposes correctness metadata", () => {
  const question = sanitizeQuestion({ id: 4, flagged: false, answer: null, quiz_question: { id: 4, position: 1, question_type: "multiple_choice_question", question_text: "<script>alert(1)</script><p onclick='x()'>Choose</p>", answers: [{ id: 9, html: "<b>Option</b>", weight: 100, answer_weight: 100, correct: true, comments: "secret" }] } });
  assert.equal(question.options[0].id, 9);
  assert.equal(question.options[0].textHtml, "<b>Option</b>");
  assert.equal("weight" in question.options[0], false);
  assert.equal("correct" in question.options[0], false);
  assert.doesNotMatch(question.questionTextHtml, /script|onclick/i);
  assert.equal(safeQuizHtml("<a href='javascript:alert(1)'>x</a>"), "<a href=\"#\">x</a>");
});

test("blocks prompts or options that the plain-text UI cannot reproduce faithfully", () => {
  assert.equal(questionHasUnsupportedMedia({ question_text: "<p>Text only</p>", answers: [{ html: "A" }] }), false);
  // Images and math render natively now (images stream through Grove's Canvas proxy).
  assert.equal(questionHasUnsupportedMedia({ question_text: "<p>Interpret <img src='chart.png'></p>" }), false);
  assert.equal(questionHasUnsupportedMedia({ question_text: "Choose", answers: [{ html: "<math><mi>x</mi></math>" }] }), false);
  assert.equal(questionHasUnsupportedMedia({ question_text: "<video src='a.mp4'></video>" }), true);
  assert.equal(questionHasUnsupportedMedia({ quiz_question: { question_text: "<svg></svg>" } }), true);
});

test("question routes request bounded Canvas pagination instead of truncating at 100", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8"));
  assert.match(source, /page <= 10/);
  assert.match(source, /per_page=100&page=\$\{page\}/);
  assert.match(source, /QUIZ_QUESTIONS_INCOMPLETE/);
  assert.match(source, /records\.length < expectedCount/);
  assert.match(source, /question bank[\s\S]*false, null/);
});

test("Canvas completion is the commit point and local bookkeeping is best effort", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8"));
  assert.match(source, /irreversible commit point/);
  assert.match(source, /try \{ await persistAttempt/);
  assert.match(source, /try \{ await enqueuePostSubmitSync/);
  assert.match(source, /submitted: true, replay: false/);
});

test("a consumed start is reported as resume-only if post-start loading fails", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8"));
  assert.match(source, /ATTEMPT_STARTED_LOAD_FAILED/);
  assert.match(source, /Do not start another attempt; retry Resume/);
  assert.match(source, /ATTEMPT_START_STATE_UNKNOWN/);
  assert.match(source, /Always[\s\S]*reread before reporting failure/);
});

test("timer reconciliation does not refetch every attempt question", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8"));
  const timer = source.slice(source.indexOf("export async function getAttemptTime"), source.indexOf("export async function startAttempt"));
  assert.match(timer, /submissionState/);
  assert.match(timer, /timeRequest/);
  assert.doesNotMatch(timer, /attemptBundle|fetchQuestionPages/);
});

test("hidden pre-start formats remain explicit-start eligible and unsafe active attempts fall back safely", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8"));
  assert.match(source, /formatVerification = "after_start"/);
  assert.match(source, /question_types[\s\S]*advertisedUnsupported/);
  assert.match(source, /type\.endsWith\("_question"\)/);
  assert.match(source, /Starting consumes an attempt and may start its timer/);
  assert.match(source, /nativeSupported: false/);
  assert.match(source, /canvasUrl: row\.quiz\.htmlUrl/);
  assert.match(source, /nativeSupported: true/);
  assert.match(source, /QUIZ_NATIVE_SUBMIT_BLOCKED/);
});
