import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  QuizInputError,
  SUPPORTED_CLASSIC_QUESTION_TYPES,
  answerRequest,
  flagRequest,
  normalizeAnswer,
  quizFailure,
  restrictionReason,
  safeQuizHtml,
  sanitizeQuestion,
  startRequest,
  submitRequest,
  timeRequest,
} from "../lib/quizzes/contracts";

test("only explicit Classic Quiz requests can start or complete an attempt", () => {
  assert.deepEqual(startRequest("11", "22"), {
    method: "POST",
    path: "/api/v1/courses/11/quizzes/22/submissions",
  });
  assert.deepEqual(submitRequest("11", "22", "33", 2, "secret"), {
    method: "POST",
    path: "/api/v1/courses/11/quizzes/22/submissions/33/complete",
    body: { attempt: 2, validation_token: "secret" },
  });
  assert.throws(() => startRequest("../11", "22"), QuizInputError);
  assert.throws(() => submitRequest("11", "22", "not-an-id", 2, "secret"), QuizInputError);
});

test("answer, flag, and timer requests use Canvas latest-attempt contracts", () => {
  assert.deepEqual(answerRequest("33", 2, "secret", "44", 7), {
    method: "POST",
    path: "/api/v1/quiz_submissions/33/questions",
    body: { attempt: 2, validation_token: "secret", quiz_questions: [{ id: "44", answer: 7 }] },
  });
  assert.deepEqual(flagRequest("33", "44", true, 2, "secret"), {
    method: "PUT",
    path: "/api/v1/quiz_submissions/33/questions/44/flag",
    body: { attempt: 2, validation_token: "secret" },
  });
  assert.deepEqual(flagRequest("33", "44", false, 2, "secret").path, "/api/v1/quiz_submissions/33/questions/44/unflag");
  assert.deepEqual(timeRequest("11", "22", "33"), {
    method: "GET",
    path: "/api/v1/courses/11/quizzes/22/submissions/33/time",
  });
});

test("New Quizzes, access restrictions, and proctoring are always blocked", () => {
  const blocked: Array<[Record<string, unknown>, string?]> = [
    [{ title: "Quiz" }, "new_quiz"],
    [{ title: "Quiz", submission_types: ["external_tool"], is_quiz_assignment: true }],
    [{ title: "Quiz", require_lockdown_browser: true }],
    [{ title: "Quiz", require_lockdown_browser_monitor: true }],
    [{ title: "Honorlock midterm" }],
    [{ title: "Quiz", access_code: "required" }],
    [{ title: "Quiz", ip_filter: "10.0.0.0/8" }],
    [{ title: "Quiz", cant_go_back: true }],
  ];
  for (const [value, engine] of blocked) assert.ok(restrictionReason(value, engine), JSON.stringify(value));
  assert.equal(restrictionReason({ title: "Ordinary Classic Quiz" }), null);
});

test("question payloads never expose correctness metadata to the client", () => {
  const result = sanitizeQuestion({
    id: 44,
    flagged: false,
    answer: null,
    quiz_question: {
      position: 1,
      question_type: "multiple_choice_question",
      question_text: "<script>steal()</script><p>Pick one</p>",
      answers: [{ id: 7, text: "Choice", weight: 100, answer_weight: 100, correct: true, answer_comments: "Correct" }],
    },
  });
  assert.equal(result.questionTextHtml, "<p>Pick one</p>");
  assert.deepEqual(result.options, [{ id: 7, textHtml: "Choice" }]);
  assert.doesNotMatch(JSON.stringify(result), /weight|correct|comment/i);
});

test("answer normalization validates but never evaluates or generates an answer", () => {
  assert.deepEqual([...SUPPORTED_CLASSIC_QUESTION_TYPES], [
    "essay_question", "short_answer_question", "calculated_question", "numerical_question",
    "multiple_choice_question", "true_false_question", "multiple_answers_question",
  ]);
  assert.equal(normalizeAnswer("short_answer_question", "my own answer"), "my own answer");
  assert.equal(normalizeAnswer("numerical_question", "0"), "0");
  assert.deepEqual(normalizeAnswer("multiple_answers_question", [2, 2, 3]), [2, 3]);
  assert.throws(() => normalizeAnswer("multiple_choice_question", "7"), QuizInputError);
  assert.throws(() => normalizeAnswer("file_upload_question", "file"), QuizInputError);
});

test("auth expiry, rate limits, restrictions, and network failures are explicit and never imply submission", () => {
  assert.deepEqual(quizFailure(401, true), {
    status: 401,
    code: "CANVAS_AUTH_EXPIRED",
    error: "Canvas sign-in has expired. Reconnect Canvas, then return to the quiz.",
  });
  assert.equal(quizFailure(429).code, "RATE_LIMITED");
  assert.equal(quizFailure(403).code, "QUIZ_RESTRICTED");
  assert.equal(quizFailure(502).code, "CANVAS_QUIZ_FAILED");
  for (const status of [401, 403, 429, 500, 502]) {
    assert.doesNotMatch(quizFailure(status).error, /submitted successfully|automatically submitted/i);
  }
});

test("Canvas-authored HTML is inert before it reaches native Quiz Mode", () => {
  const cleaned = safeQuizHtml('<p onclick="steal()">Prompt</p><iframe src="https://evil.test"></iframe><a href="javascript:steal()">link</a>');
  assert.equal(cleaned, '<p>Prompt</p><a href="#">link</a>');
  assert.doesNotMatch(cleaned, /onclick|iframe|javascript:/i);
});

test("client source contains explicit start and submit gates with no automatic completion", () => {
  const source = readFileSync(new URL("../components/ui/quiz-mode.tsx", import.meta.url), "utf8");
  assert.match(source, /Start this attempt\?/);
  assert.match(source, /confirmStart:true/);
  assert.match(source, /Submit this attempt\?/);
  assert.match(source, /confirmSubmit:true/);
  assert.doesNotMatch(source, /set(?:Timeout|Interval)\s*\(\s*\(\)\s*=>\s*(?:void\s+)?submit\s*\(/);
  assert.doesNotMatch(source, /generateAnswer|suggestAnswer|autoSubmit/i);
  assert.doesNotMatch(source, /iframe|embedded-viewer|noVNC/i);
});

test("mutation routes require idempotency and reject submit while saves remain", () => {
  const attemptRoute = readFileSync(new URL("../app/api/canvas/quizzes/[quizId]/attempt/route.ts", import.meta.url), "utf8");
  const submitRoute = readFileSync(new URL("../app/api/canvas/quizzes/[quizId]/submit/route.ts", import.meta.url), "utf8");
  assert.match(attemptRoute, /requireIdempotencyKey\(request\)/);
  assert.match(submitRoute, /requireIdempotencyKey\(request\)/);
  assert.match(submitRoute, /INVALID_PENDING_SAVES/);
  assert.match(submitRoute, /submitAttempt[\s\S]*Number\(input\.pendingSaves\)/);
});

test("hidden pre-start formats require consent and unsupported active attempts can only continue in Canvas", () => {
  const service = readFileSync(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../components/ui/quiz-mode.tsx", import.meta.url), "utf8");

  assert.match(service, /formatVerification = "after_start"/);
  assert.match(service, /Starting consumes an attempt and may start its timer/);
  assert.match(service, /question_types[\s\S]*advertisedUnsupported/);
  assert.match(service, /nativeSupported: false/);
  assert.match(service, /Your active attempt has been preserved/);
  assert.match(service, /QUIZ_NATIVE_SUBMIT_BLOCKED/);

  assert.match(client, /data\.nativeSupported===false\?"handoff":"taking"/);
  assert.match(client, /Formats are checked after you start/);
  assert.match(client, /Continue attempt in Canvas/);
  assert.match(client, /Quiz Mode has not selected, changed, or submitted any answers/);
  assert.match(client, /rel="noopener noreferrer"/);
  assert.match(client, /url\.protocol==="https:"/);
  assert.doesNotMatch(client, /<iframe|dangerouslySetInnerHTML/);
});
