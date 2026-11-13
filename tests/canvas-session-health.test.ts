import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HEALTH_EVENT_COLUMNS, healthEventRow, keepaliveDue, keepaliveMinutes, summarizeHealth, type HealthEvent } from "../lib/canvas/session-health";
import { browserLostRecoveryAction, recoveryOutcome, RECOVERY_RETRY_MS, type RecoveryCandidate } from "../lib/canvas/session-recovery";
import type { CanvasCallStats } from "../lib/canvas/session-client";

const HOUR = 3_600_000;
const t0 = new Date("2026-11-10T03:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

test("keepalive is due after the configured idle interval (default 10 minutes)", () => {
  assert.equal(keepaliveMinutes(undefined), 10);
  assert.equal(keepaliveMinutes("15"), 15);
  assert.equal(keepaliveMinutes("0"), 1);
  assert.equal(keepaliveMinutes("90"), 19, "never longer than the 20-minute institution minimum");
  assert.equal(keepaliveMinutes("abc"), 10);
  assert.equal(keepaliveDue(null, t0, 10), true);
  assert.equal(keepaliveDue(at(-9 * 60_000), t0, 10), false);
  assert.equal(keepaliveDue(at(-10 * 60_000), t0, 10), true);
});

const stats = (patch: Partial<CanvasCallStats> = {}): CanvasCallStats => ({ calls: 3, ok: 3, authRequired: 0, errors: 0, lastStatus: 200, rotatedNames: ["_csrf_token", "_normandy_session"], lastOkAt: t0, firstAuthFailureAt: null, sessionCookieReissues: 3, rememberCookiePresent: false, rememberCookieUsed: false, ...patch });

test("health rows contain exactly the value-free column set", () => {
  const row = healthEventRow(stats(), { ownerId: "o", hostedSessionId: "s", kind: "sync", at: t0 })!;
  assert.deepEqual(Object.keys(row).sort(), [...HEALTH_EVENT_COLUMNS].sort());
  assert.deepEqual([row.outcome, row.rotated, row.session_cookie_reissued, row.call_count], ["ok", true, true, 3]);
  assert.equal(healthEventRow(stats({ authRequired: 1 }), { ownerId: "o", hostedSessionId: "s", kind: "sync" })!.outcome, "auth_required");
  assert.equal(healthEventRow(stats({ ok: 0, errors: 3 }), { ownerId: "o", hostedSessionId: "s", kind: "sync" })!.outcome, "error");
  assert.equal(healthEventRow(stats({ calls: 0 }), { ownerId: "o", hostedSessionId: "s", kind: "keepalive" }), null);
  const unsafe = healthEventRow(stats({ rotatedNames: ["ok_name", "bad=value", "x".repeat(200)] }), { ownerId: "o", hostedSessionId: "s", kind: "sync" })!;
  assert.deepEqual(unsafe.cookie_names_rotated, ["ok_name"], "anything that could carry a value is dropped");
  // The migration creates the same columns and nothing that could hold a value.
  const migration = readFileSync(new URL("../drizzle/0010_canvas_session_health.sql", import.meta.url), "utf8");
  const columns = [...migration.matchAll(/^\t"([a-z_]+)" /gm)].map((match) => match[1]).filter((name) => name !== "id");
  assert.deepEqual(columns.sort(), [...HEALTH_EVENT_COLUMNS].sort());
  assert.doesNotMatch(migration, /"(value|cookie_value|header|headers|set_cookie)"/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY tenant_isolation ON "canvas_session_health_events"/);
});

const event = (offsetMs: number, patch: Partial<HealthEvent> = {}): HealthEvent => ({ at: at(offsetMs), kind: "keepalive", http_status: 200, outcome: "ok", rotated: true, session_cookie_reissued: true, remember_cookie_present: false, remember_cookie_used: false, call_count: 1, ok_count: 1, auth_required_count: 0, error_count: 0, session_cookie_reissue_count: 1, ...patch });
const every10min = (hours: number) => Array.from({ length: hours * 6 + 1 }, (_, index) => event(index * 10 * 60_000));

test("report: 27h of regular ok keepalives with reissue confirms sliding", () => {
  const report = summarizeHealth({ events: every10min(27), capturedAt: t0, status: "active", failureCode: null, now: at(27 * HOUR) });
  assert.equal(report.verdict, "SLIDING_CONFIRMED");
  assert.equal(report.calls, 27 * 6 + 1);
  assert.equal(report.longestOkGapMs, 10 * 60_000);
  assert.equal(report.longestOkSessionAgeMs, 27 * HOUR);
  assert.equal(report.sessionCookieReissueRate, 1);
  assert.equal(report.expired, false);
});

test("report: expiry pair (last ok -> first failure) and age at expiry", () => {
  const events = [...every10min(24), event(24 * HOUR + 10 * 60_000, { outcome: "auth_required", ok_count: 0, auth_required_count: 1, http_status: 401, rotated: false, session_cookie_reissued: false, session_cookie_reissue_count: 0 })];
  const report = summarizeHealth({ events, capturedAt: t0, status: "auth_required", failureCode: "CANVAS_SESSION_EXPIRED", now: at(25 * HOUR) });
  assert.equal(report.lastOkAt?.getTime(), at(24 * HOUR).getTime());
  assert.equal(report.firstFailureAt?.getTime(), at(24 * HOUR + 10 * 60_000).getTime());
  assert.equal(report.ageAtExpiryMs, 24 * HOUR + 10 * 60_000);
  assert.equal(report.verdict, "EXPIRED_AT_24h10m");
});

test("report: inconclusive verdicts for short runs, gaps, remember-me and missing reissue", () => {
  const base = { capturedAt: t0, status: "active", failureCode: null, now: at(30 * HOUR) };
  assert.equal(summarizeHealth({ ...base, events: every10min(5) }).verdict, "INCONCLUSIVE_AGE_5h00m_BELOW_26h00m");
  assert.equal(summarizeHealth({ ...base, events: every10min(27).map((item) => ({ ...item, remember_cookie_present: true })) }).verdict, "INCONCLUSIVE_REMEMBER_ME_MASKING_POSSIBLE");
  assert.equal(summarizeHealth({ ...base, events: every10min(27).map((item, index) => ({ ...item, remember_cookie_used: index === 50 })) }).verdict, "INCONCLUSIVE_REMEMBER_ME_REAUTH_OBSERVED");
  const gapped = every10min(27).filter((item) => item.at.getTime() < at(10 * HOUR).getTime() || item.at.getTime() > at(12 * HOUR).getTime());
  const gap = summarizeHealth({ ...base, events: gapped });
  assert.equal(gap.longestOkGapMs, 2 * HOUR + 20 * 60_000);
  assert.equal(gap.verdict, "INCONCLUSIVE_OK_GAP_2h20m");
  const noReissue = every10min(27).map((item) => ({ ...item, rotated: false, session_cookie_reissued: false, session_cookie_reissue_count: 0 }));
  assert.equal(summarizeHealth({ ...base, events: noReissue }).verdict, "INCONCLUSIVE_IRREGULAR_SESSION_REISSUE");
  assert.equal(summarizeHealth({ ...base, capturedAt: null, events: [] }).verdict, "INCONCLUSIVE_NO_DATA");
});

const stranded = (patch: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({ status: "auth_required", failureCode: "BROWSER_SESSION_NOT_FOUND", hasEncryptedState: true, hasCanvasAccount: true, monitorLive: false, revoked: false, lastAuthCheckAt: at(-HOUR), ...patch });

test("stranded browser-lost session with a stored jar is probed, not left auth_required", () => {
  assert.equal(browserLostRecoveryAction(stranded(), t0), "probe");
  assert.equal(recoveryOutcome({ ok: true, authRequired: false }), "activate");
  assert.equal(recoveryOutcome({ ok: false, authRequired: true }), "expire", "only a real Canvas rejection requires sign-in");
  assert.equal(recoveryOutcome({ ok: false, authRequired: false }), "retry-later");
  assert.equal(recoveryOutcome("unreachable"), "retry-later");
});

test("recovery never probes the wrong sessions and retries are bounded", () => {
  assert.equal(browserLostRecoveryAction(stranded({ hasEncryptedState: false }), t0), "skip", "never-authenticated attempt");
  assert.equal(browserLostRecoveryAction(stranded({ hasCanvasAccount: false }), t0), "skip");
  assert.equal(browserLostRecoveryAction(stranded({ monitorLive: true }), t0), "skip", "do not race an interactive sign-in");
  assert.equal(browserLostRecoveryAction(stranded({ failureCode: "CANVAS_SESSION_EXPIRED" }), t0), "skip", "idempotent: runs once");
  assert.equal(browserLostRecoveryAction(stranded({ status: "active" }), t0), "skip");
  assert.equal(browserLostRecoveryAction(stranded({ revoked: true }), t0), "skip");
  assert.equal(browserLostRecoveryAction(stranded({ lastAuthCheckAt: at(-RECOVERY_RETRY_MS + 1000) }), t0), "skip", "backoff between transient failures");
  assert.equal(browserLostRecoveryAction(stranded({ lastAuthCheckAt: at(-RECOVERY_RETRY_MS) }), t0), "probe");
});

test("anti-churn: monitors are still never re-enqueued for BROWSER_SESSION_NOT_FOUND", () => {
  const worker = readFileSync(new URL("../scripts/sync-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /not \(s\.status='auth_required' and coalesce\(s\.failure_code,''\) in \('BROWSER_SESSION_NOT_FOUND','AUTH_REQUIRED'\)\)/);
  assert.match(worker, /failure_code='CANVAS_SESSION_EXPIRED'/);
});
