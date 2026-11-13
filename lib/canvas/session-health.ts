// Session-lifetime measurement for server-side (cookie) Canvas access.
// Pure functions only: the worker, the app and scripts/session-health-report.ts
// share them, and tests exercise them without a database.
//
// Canvas slides `expire_after` (default 1 day, institution minimum 20 minutes)
// on each request and re-issues `_normandy_session`. A row records names and
// booleans only; cookie values and headers are never stored.
import { SESSION_COOKIE_NAMES, type CanvasCallStats } from "./session-client";

export type HealthKind = "keepalive" | "sync" | "restore-check" | "api" | "page-keepalive";
export type HealthOutcome = "ok" | "auth_required" | "error";

/** The complete, value-free column set of canvas_session_health_events (besides id). */
export const HEALTH_EVENT_COLUMNS = [
  "owner_id", "hosted_session_id", "at", "kind", "http_status", "outcome", "rotated", "cookie_names_rotated",
  "session_cookie_reissued", "remember_cookie_present", "remember_cookie_used",
  "call_count", "ok_count", "auth_required_count", "error_count", "session_cookie_reissue_count",
] as const;
export type HealthEventRow = {
  owner_id: string; hosted_session_id: string; at: Date; kind: HealthKind; http_status: number | null; outcome: HealthOutcome;
  rotated: boolean; cookie_names_rotated: string[]; session_cookie_reissued: boolean; remember_cookie_present: boolean; remember_cookie_used: boolean;
  call_count: number; ok_count: number; auth_required_count: number; error_count: number; session_cookie_reissue_count: number;
};

export const DEFAULT_KEEPALIVE_MINUTES = 10;

export function keepaliveMinutes(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed)) return DEFAULT_KEEPALIVE_MINUTES;
  // Below 1 minute is abusive; above 19 could miss a 20-minute institution timeout.
  return Math.min(19, Math.max(1, Math.round(parsed)));
}

/** Alternate API and page keepalives: after an API keepalive do a page touch, and vice versa. Never more often than keepaliveDue allows. */
export function nextKeepaliveKind(lastKeepaliveKind: string | null | undefined, pageEnabled: boolean): "keepalive" | "page-keepalive" {
  return pageEnabled && lastKeepaliveKind === "keepalive" ? "page-keepalive" : "keepalive";
}

/** CANVAS_PAGE_KEEPALIVE: on unless explicitly 0/false/off/no. */
export function pageKeepaliveEnabled(value: string | undefined): boolean {
  return !/^(0|false|off|no)$/i.test((value ?? "").trim());
}

/** True when no Canvas call (of any kind) has been recorded for the session within the interval. */
export function keepaliveDue(lastCallAt: Date | null, now: Date, minutes: number): boolean {
  if (!lastCallAt) return true;
  return now.getTime() - lastCallAt.getTime() >= minutes * 60_000;
}

/**
 * One row per sync job / app request batch / keepalive, aggregating that
 * client's calls. A per-call row would be ~150 rows per quiz or content sync
 * (every 1–5 minutes near deadlines), i.e. >100k rows/day, without improving
 * the measurement: the lifetime question needs only when calls last succeeded
 * and first failed, which job granularity (≤ the keepalive interval) gives.
 */
export function healthEventRow(stats: CanvasCallStats, input: { ownerId: string; hostedSessionId: string; kind: HealthKind; at?: Date }): HealthEventRow | null {
  if (!stats.calls) return null;
  const rotatedNames = stats.rotatedNames.filter((name) => /^[\w.-]{1,128}$/.test(name)).slice(0, 32);
  return {
    owner_id: input.ownerId, hosted_session_id: input.hostedSessionId, at: input.at ?? new Date(), kind: input.kind,
    http_status: stats.lastStatus, outcome: stats.authRequired ? "auth_required" : stats.ok ? "ok" : "error",
    rotated: rotatedNames.some((name) => SESSION_COOKIE_NAMES.includes(name)), cookie_names_rotated: rotatedNames,
    session_cookie_reissued: stats.sessionCookieReissues > 0, remember_cookie_present: stats.rememberCookiePresent, remember_cookie_used: stats.rememberCookieUsed,
    call_count: stats.calls, ok_count: stats.ok, auth_required_count: stats.authRequired, error_count: stats.errors, session_cookie_reissue_count: stats.sessionCookieReissues,
  };
}

// ---------------------------------------------------------------- report

export type HealthEvent = Pick<HealthEventRow, "at" | "kind" | "http_status" | "outcome" | "rotated" | "session_cookie_reissued" | "remember_cookie_present" | "remember_cookie_used" | "call_count" | "ok_count" | "auth_required_count" | "error_count" | "session_cookie_reissue_count">;
export type HealthReport = {
  capturedAt: Date | null; sinceCaptureMs: number | null; status: string; failureCode: string | null;
  events: number; calls: number; ok: number; authRequired: number; errors: number;
  rotationCount: number; lastRotationAt: Date | null;
  sessionCookieReissueRate: number | null; longestReissueGapMs: number | null;
  rememberCookiePresent: boolean; rememberCookieUsed: boolean;
  longestOkGapMs: number | null; lastOkAt: Date | null; longestOkSessionAgeMs: number | null;
  expired: boolean; firstFailureAt: Date | null; ageAtExpiryMs: number | null;
  verdict: string;
};

export const SLIDING_PROOF_MS = 26 * 3_600_000;
export const MAX_HEALTHY_GAP_MS = 30 * 60_000;

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function longestGap(times: number[]): number | null {
  if (times.length < 2) return null;
  let longest = 0;
  for (let index = 1; index < times.length; index += 1) longest = Math.max(longest, times[index] - times[index - 1]);
  return longest;
}

export function summarizeHealth(input: { events: HealthEvent[]; capturedAt: Date | null; status: string; failureCode: string | null; now: Date }): HealthReport {
  const events = [...input.events].sort((left, right) => left.at.getTime() - right.at.getTime());
  const sum = (pick: (event: HealthEvent) => number) => events.reduce((total, event) => total + pick(event), 0);
  const capturedAt = input.capturedAt ?? events[0]?.at ?? null;
  const start = capturedAt ? [capturedAt.getTime()] : [];
  const okTimes = events.filter((event) => event.ok_count > 0).map((event) => event.at.getTime());
  // `rotated` covers every session cookie name; rows written before 2026-11-10 only counted `_normandy_session`
  // in session_cookie_reissued, which missed schools on the newer `canvas_session` name (e.g. UF).
  const reissued = (event: HealthEvent) => event.session_cookie_reissued || event.rotated;
  const reissueTimes = events.filter(reissued).map((event) => event.at.getTime());
  const rotations = events.filter((event) => event.rotated);
  const firstFailure = events.find((event) => event.auth_required_count > 0) ?? null;
  // Only successes before the first auth failure count toward the proven lifetime.
  const okBeforeFailure = firstFailure ? okTimes.filter((time) => time < firstFailure.at.getTime()) : okTimes;
  const lastOk = okBeforeFailure.at(-1) ?? null;
  const calls = sum((event) => event.call_count);
  const report: HealthReport = {
    capturedAt, sinceCaptureMs: capturedAt ? input.now.getTime() - capturedAt.getTime() : null, status: input.status, failureCode: input.failureCode,
    events: events.length, calls, ok: sum((event) => event.ok_count), authRequired: sum((event) => event.auth_required_count), errors: sum((event) => event.error_count),
    rotationCount: rotations.length, lastRotationAt: rotations.at(-1)?.at ?? null,
    sessionCookieReissueRate: calls ? sum((event) => Math.max(event.session_cookie_reissue_count, reissued(event) ? 1 : 0)) / calls : null,
    longestReissueGapMs: longestGap([...start, ...reissueTimes]),
    rememberCookiePresent: events.some((event) => event.remember_cookie_present), rememberCookieUsed: events.some((event) => event.remember_cookie_used),
    longestOkGapMs: longestGap([...start, ...okBeforeFailure]), lastOkAt: lastOk === null ? null : new Date(lastOk),
    longestOkSessionAgeMs: capturedAt && lastOk !== null ? lastOk - capturedAt.getTime() : null,
    expired: Boolean(firstFailure), firstFailureAt: firstFailure?.at ?? null,
    ageAtExpiryMs: firstFailure && capturedAt ? firstFailure.at.getTime() - capturedAt.getTime() : null,
    verdict: "",
  };
  report.verdict = verdict(report);
  return report;
}

export function verdict(report: HealthReport): string {
  if (report.expired) return `EXPIRED_AT_${report.ageAtExpiryMs === null ? "UNKNOWN" : formatDuration(report.ageAtExpiryMs)}`;
  if (!report.capturedAt || report.longestOkSessionAgeMs === null) return "INCONCLUSIVE_NO_DATA";
  if (report.rememberCookieUsed) return "INCONCLUSIVE_REMEMBER_ME_REAUTH_OBSERVED";
  if (report.rememberCookiePresent) return "INCONCLUSIVE_REMEMBER_ME_MASKING_POSSIBLE";
  if (report.longestOkSessionAgeMs <= SLIDING_PROOF_MS) return `INCONCLUSIVE_AGE_${formatDuration(report.longestOkSessionAgeMs)}_BELOW_26h00m`;
  if (report.longestOkGapMs !== null && report.longestOkGapMs > MAX_HEALTHY_GAP_MS) return `INCONCLUSIVE_OK_GAP_${formatDuration(report.longestOkGapMs)}`;
  if (!report.sessionCookieReissueRate || report.longestReissueGapMs === null || report.longestReissueGapMs > MAX_HEALTHY_GAP_MS) return "INCONCLUSIVE_IRREGULAR_SESSION_REISSUE";
  return "SLIDING_CONFIRMED";
}
