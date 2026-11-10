import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(new URL("../scripts/sync-worker.ts", import.meta.url), "utf8");
// The transactional finalizer is shared by the worker and the /confirm route.
const finalizer = readFileSync(new URL("../lib/bridge/complete-authentication.ts", import.meta.url), "utf8");
const store = readFileSync(new URL("../lib/bridge/postgres-hosted-store.ts", import.meta.url), "utf8");
const connect = readFileSync(new URL("../app/api/canvas/sessions/[sessionId]/connect/route.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../lib/bridge/hosted-browser.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0009_interactive_auth_attempt.sql", import.meta.url), "utf8");

test("interactive sign-in deadline is a persisted attempt property", () => {
  assert.match(migration, /interactive_attempt_id/);
  assert.match(migration, /interactive_attempt_started_at/);
  assert.match(migration, /interactive_attempt_deadline_at/);
  assert.match(worker, /s\.interactive_attempt_deadline_at/);
  assert.match(worker, /s\.failure_code is null or s\.failure_code not in/);
  assert.doesNotMatch(worker, /s\.created_at\+interval '30 minutes'/);
  assert.match(api, /interactiveAttemptDeadlineAt/);
});

test("29:59 remains pending while 30:00 enters attempt-bound cleanup", () => {
  assert.match(worker, /m\.deadline_at<=now\(\)/);
  assert.match(worker, /deadline_at>now\(\)/);
  assert.match(worker, /m\.auth_attempt_id=s\.interactive_attempt_id/);
  assert.match(worker, /INTERACTIVE_AUTH_TIMEOUT_CLEANUP_PENDING/);
  assert.match(worker, /INTERACTIVE_AUTH_TIMEOUT/);
});

test("deadline success uses the complete transactional finalizer", () => {
  assert.match(worker, /snapshotEncrypted\(session\.provider_session_ref, ownerId\)/);
  assert.match(worker, /completeAuthentication\(monitor, observed\.canvasAccountId, encrypted\)/);
  assert.match(finalizer, /insert into canvas_accounts/);
  assert.match(finalizer, /insert into sync_policies/);
  assert.match(worker, /completeAuthenticationTx\(tx, monitor, canvasUserId, encrypted\)/);
  assert.match(finalizer, /insert into sync_jobs/);
  assert.match(finalizer, /status='succeeded'/);
  // Login-only browser: the winner revokes the viewer AND terminates the browser.
  assert.match(worker, /releaseLoginBrowser\(hostedBrowserProvider, session\.provider_session_ref\)/);
  assert.match(finalizer, /for update of s,m/);
});

test("snapshot or transaction failure cannot terminate observed authenticated runtime", () => {
  const activeBranch = worker.slice(worker.indexOf('if (observed?.state === "active"'), worker.indexOf("const terminated =", worker.indexOf('if (observed?.state === "active"')));
  assert.match(activeBranch, /catch \{ \/\* snapshot\/finalization failure/);
  assert.match(activeBranch, /continue;/);
  assert.doesNotMatch(activeBranch, /terminate\(/);
});

test("expired ordinary connect is denied and explicit restart is idempotent", () => {
  assert.match(connect, /INTERACTIVE_AUTH_TIMEOUT/);
  assert.match(connect, /hosted\.interactiveAttemptDeadlineAt <= Date\.now\(\)/);
  assert.doesNotMatch(connect, /\["awaiting-login", "auth-expired"\]/);
  assert.match(store, /\["provisioning", "auth_required"\]\.includes\(current\.status\)/);
  assert.match(store, /current\.status !== "expired"/);
  assert.match(store, /eq\(hostedBrowserSessions\.status, "expired"\)/);
  assert.match(connect, /!hosted\.interactiveAttemptId \|\| !hosted\.interactiveAttemptDeadlineAt/);
  assert.match(store, /failureCode === "BROWSER_SESSION_NOT_FOUND" && !current\.interactiveAttemptId/);
  assert.match(store, /current\.interactiveAttemptId[\s\S]*current\.interactiveAttemptDeadlineAt[\s\S]*getTime\(\) > Date\.now\(\)/);
});

test("old attempt cannot mutate or delete a newer attempt", () => {
  assert.match(worker + finalizer, /s\.interactive_attempt_id=\$\{monitor\.attemptId\}/);
  assert.match(worker + finalizer, /m\.auth_attempt_id=\$\{monitor\.attemptId\}/);
  assert.match(worker, /interactive_attempt_id=\$\{session\.interactive_attempt_id\}/);
  assert.match(connect, /claimed\.interactiveAttemptId !== hosted\.interactiveAttemptId/);
});

test("warm and active sessions are excluded from timeout cleanup", () => {
  assert.match(worker, /s\.status<>'active'/);
  assert.match(worker, /from hosted_browser_sessions s join interactive_session_monitors/);
});

test("an attempt that expires before provisioning still reaches terminal cleanup", () => {
  assert.match(worker, /pendingProvider = session\.provider_session_ref\.startsWith\("pending:"\)/);
  assert.match(worker, /terminated = pendingProvider \|\|/);
});
