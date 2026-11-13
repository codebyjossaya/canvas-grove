import assert from "node:assert/strict";
import test from "node:test";
import { isAuthFailure, isPermissionDenial401 } from "../lib/canvas/session-client";
import { quizFailure, restrictionReason } from "../lib/quizzes/contracts";

const origin = "https://ufl.instructure.com";
const body = (value: unknown) => Buffer.from(JSON.stringify(value));

test("Canvas permission-denied 401 is not a session expiry", () => {
  const denied = body({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
  assert.equal(isPermissionDenial401(denied), true);
  assert.equal(isAuthFailure(401, {}, origin, denied), false);
  assert.equal(isAuthFailure(401, {}, origin, Buffer.from("while(1);" + JSON.stringify({ status: "unauthorized" }))), false);
});

test("unauthenticated, empty or unreadable 401 still means the session expired", () => {
  assert.equal(isAuthFailure(401, {}, origin, body({ status: "unauthenticated", errors: [{ message: "user authorization required" }] })), true);
  assert.equal(isAuthFailure(401, {}, origin, Buffer.alloc(0)), true);
  assert.equal(isAuthFailure(401, {}, origin, Buffer.from("<html>")), true);
  assert.equal(isAuthFailure(401, {}, origin), true);
});

test("quiz failure maps permission 401 to a non-reconnect error", () => {
  assert.equal(quizFailure(401, false).code, "QUIZ_PERMISSION_DENIED");
  assert.equal(quizFailure(401, true).code, "CANVAS_AUTH_EXPIRED");
});

test("one-question-at-a-time quizzes are supported through the quiz player engine (lib/quizzes/oqaat.ts)", () => {
  assert.equal(restrictionReason({ one_question_at_a_time: true }), null);
  assert.equal(restrictionReason({ one_question_at_a_time: false }), null);
  assert.match(restrictionReason({ one_question_at_a_time: true, cant_go_back: true }) ?? "", /prevents returning/);
});
