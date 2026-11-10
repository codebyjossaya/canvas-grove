// The single, transactional finalizer for an interactive Canvas sign-in. Used by
// the durable auth monitor (scripts/sync-worker.ts) and by the user-triggered
// fast confirmation route (app/api/canvas/sessions/[sessionId]/confirm). Both
// callers race safely: the monitor row is locked FOR UPDATE and moved to
// 'succeeded' in the same transaction, so exactly one caller returns true and
// every later call is a no-op returning false.
//
// Relative imports only: this module is also loaded by the worker via tsx.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { syncPolicies, type SyncKind } from "../sync/catalog";
import type { EncryptedBrowserState } from "./hosted-browser";

export type AuthCompletionTarget = {
  monitorId: string;
  attemptId: string;
  ownerId: string;
  hostedSessionId: string;
  canvasOrigin: string;
  institutionName: string;
  /** Present when the caller holds the monitor lease; absent callers may finalize a queued or leased monitor. */
  leaseToken?: string;
};

const kinds = Object.keys(syncPolicies) as SyncKind[];

/**
 * The hosted browser is login-only. Once completeAuthenticationTx has
 * committed the encrypted cookie jar, every caller that won the race destroys
 * the browser: revoke the live viewer, then terminate the container. Sync and
 * app calls use the server-side API client (lib/canvas/session-client.ts).
 * A browser that is already gone counts as released.
 */
export async function releaseLoginBrowser(provider: { relinquishInteractive(ref: string): Promise<unknown>; terminate(ref: string): Promise<void> }, providerSessionRef: string): Promise<boolean> {
  await provider.relinquishInteractive(providerSessionRef).catch(() => undefined);
  try { await provider.terminate(providerSessionRef); return true; }
  catch (error) { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "BROWSER_SESSION_NOT_FOUND"); }
}

export async function completeAuthenticationTx(tx: postgres.TransactionSql, monitor: AuthCompletionTarget, canvasUserId: string, encrypted: EncryptedBrowserState): Promise<boolean> {
  const tokenHash = monitor.leaseToken ? createHash("sha256").update(monitor.leaseToken).digest("hex") : null;
  const locked = await tx<{ id: string }[]>`select s.id from hosted_browser_sessions s join interactive_session_monitors m on m.owner_id=s.owner_id and m.hosted_session_id=s.id
    where s.owner_id=${monitor.ownerId} and s.id=${monitor.hostedSessionId} and s.interactive_attempt_id=${monitor.attemptId}
      and m.id=${monitor.monitorId} and m.auth_attempt_id=${monitor.attemptId} and m.status in ('queued','leased')
      and (${tokenHash}::text is null or m.lease_token_hash=${tokenHash}) for update of s,m`;
  if (!locked.length) return false;
  const accounts = await tx<{ id: string }[]>`insert into canvas_accounts(owner_id,canvas_base_url,institution_name,canvas_user_id,status,updated_at)
    values(${monitor.ownerId},${monitor.canvasOrigin},${monitor.institutionName},${canvasUserId},'connected',now())
    on conflict(owner_id,canvas_base_url,canvas_user_id) do update set institution_name=excluded.institution_name,status='connected',updated_at=now() returning id`;
  const accountId = accounts[0].id;
  await tx`update hosted_browser_sessions set canvas_account_id=${accountId},canvas_external_account_id=${canvasUserId},status='active',last_auth_check_at=now(),failure_code=null,
    encrypted_state_ciphertext=${JSON.stringify({ ciphertext: encrypted.ciphertext, authTag: encrypted.authTag, algorithm: encrypted.algorithm })},encrypted_state_nonce=${encrypted.iv},wrapped_data_key=${encrypted.wrappedDataKey},key_version=${Number.parseInt(encrypted.keyId, 10) || 1},updated_at=now()
    where owner_id=${monitor.ownerId} and id=${monitor.hostedSessionId} and interactive_attempt_id=${monitor.attemptId}`;
  await tx`update hosted_browser_profiles set canvas_account_id=${accountId},updated_at=now() where owner_id=${monitor.ownerId} and id=(select profile_id from hosted_browser_sessions where owner_id=${monitor.ownerId} and id=${monitor.hostedSessionId})`;
  for (const kind of kinds) {
    const policy = syncPolicies[kind];
    const rows = await tx<{ id: string }[]>`insert into sync_policies(owner_id,canvas_account_id,resource_type,interval_seconds,freshness_seconds,priority,next_run_at,status)
      values(${monitor.ownerId},${accountId},${kind},${Math.round(policy.intervalMs / 1000)},${Math.round(policy.staleAfterMs / 1000)},${policy.priority},now(),'active')
      on conflict(canvas_account_id,resource_type,scope_key) do update set status='active',next_run_at=now(),last_error_at=null,last_error_code=null,updated_at=now() returning id`;
    await tx`insert into sync_jobs(owner_id,canvas_account_id,policy_id,hosted_session_id,kind,scope,dedupe_key,status,priority,max_attempts,run_after)
      values(${monitor.ownerId},${accountId},${rows[0].id},${monitor.hostedSessionId},${kind},${tx.json({})},${`${accountId}:${kind}`},'queued',${policy.priority},5,now()) on conflict do nothing`;
  }
  await tx`update interactive_session_monitors set status='succeeded',lease_owner=null,lease_token_hash=null,lease_expires_at=null,last_observed_state='active',last_error_code=null,finished_at=now(),updated_at=now() where owner_id=${monitor.ownerId} and id=${monitor.monitorId} and auth_attempt_id=${monitor.attemptId}`;
  return true;
}

export type PendingAuthMonitor = AuthCompletionTarget & { providerSessionRef: string; sessionStatus: string };

/** The live monitor for a session's current interactive attempt, or the session's status when none remains. */
export async function findPendingAuthMonitorTx(tx: postgres.TransactionSql, ownerId: string, hostedSessionId: string): Promise<{ monitor: PendingAuthMonitor | null; sessionStatus: string | null }> {
  const rows = await tx<{ status: string; provider_session_ref: string | null; monitor_id: string | null; attempt_id: string | null; canvas_origin: string; institution_name: string }[]>`
    select s.status,s.provider_session_ref,m.id monitor_id,m.auth_attempt_id attempt_id,p.canvas_origin,p.institution_name
    from hosted_browser_sessions s
    join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
    left join interactive_session_monitors m on m.owner_id=s.owner_id and m.hosted_session_id=s.id and m.auth_attempt_id=s.interactive_attempt_id and m.status in ('queued','leased')
    where s.owner_id=${ownerId} and s.id=${hostedSessionId} and s.revoked_at is null
    limit 1`;
  const row = rows[0];
  if (!row) return { monitor: null, sessionStatus: null };
  const ref = row.provider_session_ref;
  if (!row.monitor_id || !row.attempt_id || !ref || ref.startsWith("pending:") || ref.startsWith("revoked:")) return { monitor: null, sessionStatus: row.status };
  return { sessionStatus: row.status, monitor: { monitorId: row.monitor_id, attemptId: row.attempt_id, ownerId, hostedSessionId, canvasOrigin: row.canvas_origin, institutionName: row.institution_name, providerSessionRef: ref, sessionStatus: row.status } };
}
