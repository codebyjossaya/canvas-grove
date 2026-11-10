import assert from "node:assert/strict";
import test from "node:test";
import { interactiveAuthTime, shouldShowInteractiveAuthDeadline } from "../lib/interactive-auth-deadline";

const now = Date.parse("2026-11-09T12:00:00.000Z");
const after = (seconds: number) => new Date(now + seconds * 1000).toISOString();

test("formats the approved countdown thresholds from an absolute deadline", () => {
  assert.deepEqual(interactiveAuthTime(after(1799), now), {
    secondsRemaining: 1799,
    urgency: "normal",
    display: "29:59",
    accessible: "Secure sign-in expires in 29 minutes and 59 seconds",
  });
  assert.equal(interactiveAuthTime(after(300), now)?.urgency, "warning");
  assert.equal(interactiveAuthTime(after(300), now)?.display, "5:00");
  assert.equal(interactiveAuthTime(after(60), now)?.urgency, "urgent");
  assert.equal(interactiveAuthTime(after(60), now)?.display, "1:00");
  assert.equal(interactiveAuthTime(after(0), now)?.urgency, "expired");
  assert.equal(interactiveAuthTime(after(0), now)?.display, "0:00");
});

test("rejects missing or invalid deadlines", () => {
  assert.equal(interactiveAuthTime(null, now), null);
  assert.equal(interactiveAuthTime("not-a-date", now), null);
});

test("shows only persisted pending-auth deadlines and never warm/active sessions", () => {
  for (const state of ["provisioning", "awaiting-login"]) {
    assert.equal(shouldShowInteractiveAuthDeadline({ state, interactiveAuthExpiresAt: after(300) }), true);
  }
  for (const state of ["active", "auth-expired", "failed", "terminated"]) {
    assert.equal(shouldShowInteractiveAuthDeadline({ state, interactiveAuthExpiresAt: after(300) }), false);
  }
});
