// One-time, idempotent recovery for sessions that the old browser-backed sync
// stranded as auth_required/BROWSER_SESSION_NOT_FOUND although their captured
// cookie jar is intact (e.g. 6d49133c after the 2026-11-10 OOM kill). With the
// direct API there is no browser to lose, so the worker probes
// /api/v1/users/self with the stored cookies and either reactivates the session
// or marks it CANVAS_SESSION_EXPIRED. Either outcome changes failure_code, so a
// session is probed successfully at most once; transport errors retry no more
// often than RECOVERY_RETRY_MS.

export const RECOVERY_RETRY_MS = 5 * 60_000;
export const STRANDED_FAILURE_CODE = "BROWSER_SESSION_NOT_FOUND";

export type RecoveryCandidate = { status: string; failureCode: string | null; hasEncryptedState: boolean; hasCanvasAccount: boolean; monitorLive: boolean; revoked: boolean; lastAuthCheckAt: Date | null };

export function browserLostRecoveryAction(candidate: RecoveryCandidate, now: Date): "probe" | "skip" {
  if (candidate.revoked || candidate.status !== "auth_required" || candidate.failureCode !== STRANDED_FAILURE_CODE) return "skip";
  // A never-authenticated attempt has no jar/account: it needs interactive sign-in, not a probe.
  if (!candidate.hasEncryptedState || !candidate.hasCanvasAccount) return "skip";
  // Never race a live interactive sign-in attempt.
  if (candidate.monitorLive) return "skip";
  if (candidate.lastAuthCheckAt && now.getTime() - candidate.lastAuthCheckAt.getTime() < RECOVERY_RETRY_MS) return "skip";
  return "probe";
}

export function recoveryOutcome(probe: { ok: boolean; authRequired: boolean } | "unreachable"): "activate" | "expire" | "retry-later" {
  if (probe === "unreachable") return "retry-later";
  if (probe.ok) return "activate";
  return probe.authRequired ? "expire" : "retry-later";
}
