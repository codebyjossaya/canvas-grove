// Raw postgres.js SQL shared verbatim by the sync worker and the app
// (via withTenantSql). Every statement runs inside a tenant transaction
// (app.user_id set), so RLS scopes it to the owner.
import type postgres from "postgres";
import type { EncryptedBrowserState } from "../bridge/hosted-browser";
import type { EncryptedStateRecord, EncryptedStateStore } from "./session-client";
import { HEALTH_EVENT_COLUMNS, type HealthEventRow } from "./session-health";

export type TenantRunner = <T>(work: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>;
type StateRow = { encrypted_state_ciphertext: string | null; encrypted_state_nonce: string | null; wrapped_data_key: string | null; key_version: number | null };

export function encryptedStateFromRow(row: StateRow | undefined): EncryptedBrowserState | null {
  if (!row?.encrypted_state_ciphertext || !row.encrypted_state_nonce || !row.wrapped_data_key || row.key_version == null) return null;
  let payload: { ciphertext?: unknown; authTag?: unknown; algorithm?: unknown };
  try { payload = JSON.parse(row.encrypted_state_ciphertext) as typeof payload; } catch { return null; }
  if (typeof payload.ciphertext !== "string" || typeof payload.authTag !== "string" || payload.algorithm !== "AES-256-GCM") return null;
  return { ciphertext: payload.ciphertext, authTag: payload.authTag, algorithm: "AES-256-GCM", iv: row.encrypted_state_nonce, wrappedDataKey: row.wrapped_data_key, keyId: String(row.key_version) };
}

/**
 * Compare-and-swap on the stored IV: every envelope encryption draws a fresh
 * IV, so it is a perfect version token and parallel writers cannot silently
 * overwrite each other's cookie rotations.
 */
export function sqlEncryptedStateStore(run: TenantRunner, ownerId: string, hostedSessionId: string, options: { requireActive?: boolean } = {}): EncryptedStateStore {
  const requireActive = options.requireActive ?? true;
  return {
    async load(): Promise<EncryptedStateRecord | null> {
      const rows = await run((tx) => tx<StateRow[]>`select encrypted_state_ciphertext,encrypted_state_nonce,wrapped_data_key,key_version from hosted_browser_sessions
        where owner_id=${ownerId} and id=${hostedSessionId} and revoked_at is null and (${!requireActive} or status='active') limit 1`);
      const state = encryptedStateFromRow(rows[0]);
      return state ? { state, version: state.iv } : null;
    },
    async compareAndSwap(next: EncryptedBrowserState, expectedVersion: string): Promise<boolean> {
      const rows = await run((tx) => tx<{ id: string }[]>`update hosted_browser_sessions set
          encrypted_state_ciphertext=${JSON.stringify({ ciphertext: next.ciphertext, authTag: next.authTag, algorithm: next.algorithm })},
          encrypted_state_nonce=${next.iv},wrapped_data_key=${next.wrappedDataKey},key_version=${Number.parseInt(next.keyId, 10) || 1},updated_at=now()
        where owner_id=${ownerId} and id=${hostedSessionId} and revoked_at is null and encrypted_state_nonce=${expectedVersion} returning id`);
      return rows.length === 1;
    },
  };
}

/** Inserts exactly the value-free HEALTH_EVENT_COLUMNS. */
export async function insertHealthEvent(tx: postgres.TransactionSql, row: HealthEventRow): Promise<void> {
  const values = Object.fromEntries(HEALTH_EVENT_COLUMNS.map((column) => [column, row[column]]));
  await tx`insert into canvas_session_health_events ${tx(values as Record<string, postgres.ParameterOrJSON<never>>, ...HEALTH_EVENT_COLUMNS)}`;
}
