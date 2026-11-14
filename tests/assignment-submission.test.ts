import assert from "node:assert/strict";
import test from "node:test";
import {
  AssignmentSubmissionInputError,
  assertLiveAssignmentAllows,
  assignmentPreflightPath,
  assignmentSubmissionRequest,
  parseAssignmentSubmission,
  submissionFailure,
} from "../lib/assignments/contracts";

test("assignment submission requests use Canvas's nested submission contract", () => {
  assert.deepEqual(assignmentSubmissionRequest("12", "34", parseAssignmentSubmission({ type: "online_text_entry", body: "My answer" })), {
    method: "POST", path: "/api/v1/courses/12/assignments/34/submissions",
    body: { submission: { submission_type: "online_text_entry", body: "My answer" } },
  });
  assert.deepEqual(assignmentSubmissionRequest("12", "34", parseAssignmentSubmission({ type: "online_url", url: "https://example.com/work" })), {
    method: "POST", path: "/api/v1/courses/12/assignments/34/submissions",
    body: { submission: { submission_type: "online_url", url: "https://example.com/work" } },
  });
  assert.deepEqual(assignmentSubmissionRequest("12", "34", parseAssignmentSubmission({ type: "online_upload", canvasFileIds: ["91", "92"] })), {
    method: "POST", path: "/api/v1/courses/12/assignments/34/submissions",
    body: { submission: { submission_type: "online_upload", file_ids: ["91", "92"] } },
  });
  assert.equal(assignmentPreflightPath("12", "34"), "/api/v1/courses/12/assignments/34?include[]=submission&include[]=can_submit");
});

test("assignment submission inputs reject empty, unsafe, oversized, and ambiguous content", () => {
  const invalid = [
    { type: "online_text_entry", body: "  " },
    { type: "online_text_entry", body: "x".repeat(50_001) },
    { type: "online_url", url: "javascript:alert(1)" },
    { type: "online_url", url: "https://user:secret@example.com" },
    { type: "online_upload", canvasFileIds: [] },
    { type: "online_upload", canvasFileIds: ["7", "7"] },
    { type: "online_upload", canvasFileIds: ["not-an-id"] },
  ];
  for (const value of invalid) assert.throws(() => parseAssignmentSubmission(value), AssignmentSubmissionInputError, JSON.stringify(value));
});

test("fresh Canvas assignment gate permits supported attempts and fails closed", () => {
  const open = { published: true, locked_for_user: false, submission_types: ["online_text_entry", "online_url"], allowed_attempts: 2, submission: { attempt: 1, workflow_state: "submitted", submitted_at: "2026-11-01T00:00:00Z" } };
  assert.deepEqual(assertLiveAssignmentAllows(open, "online_url"), { submissionTypes: ["online_text_entry", "online_url"], previousAttempt: 1, allowedAttempts: 2 });
  assert.deepEqual(assertLiveAssignmentAllows({ ...open, allowed_attempts: null }, "online_url").allowedAttempts, null);
  assert.equal(assertLiveAssignmentAllows({ ...open, allowed_attempts: 1, submission: { ...open.submission, extra_attempts: 1 } }, "online_url").allowedAttempts, 2);
  for (const value of [
    { ...open, published: false },
    { ...open, locked_for_user: true, lock_explanation: "<p>Closed by instructor</p>" },
    { ...open, unlock_at: "2999-01-01T00:00:00Z" },
    { ...open, allowed_attempts: 1 },
    { ...open, can_submit: false },
    { ...open, submission_types: ["online_text_entry"] },
    null,
  ]) assert.throws(() => assertLiveAssignmentAllows(value, "online_url"), AssignmentSubmissionInputError);
});

test("Canvas assignment failures preserve auth, policy, rate-limit, and uncertain-write semantics", () => {
  assert.deepEqual(submissionFailure(401, true), { status: 401, code: "CANVAS_AUTH_EXPIRED", error: "Canvas sign-in has expired. Reconnect Canvas, then try again." });
  assert.equal(submissionFailure(403).code, "SUBMISSION_NOT_ALLOWED");
  assert.equal(submissionFailure(422).code, "SUBMISSION_REJECTED");
  assert.equal(submissionFailure(429).status, 429);
  assert.equal(submissionFailure(500).code, "CANVAS_SUBMISSION_FAILED");
});
