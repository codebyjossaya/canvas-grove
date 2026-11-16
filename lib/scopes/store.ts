import "server-only";
import type postgres from "postgres";
import { withTenantSql } from "@/lib/db";
import type { DataScope, ScopeSettings } from "./catalog";
import { blockedScopeForTool, ScopeDisabledError, scopeSettingsFromRow, storedDataScopes } from "./settings";

// Scope settings live on user_preferences (data_scopes, agent_defaults, scopes_saved_at).
// Every read and write runs in the owner's tenant transaction (forced RLS).

type Tx = postgres.TransactionSql;
type Row = { data_scopes: string[] | null; agent_defaults: unknown; scopes_saved_at: Date | string | null };

/** Enabled data scopes inside an existing tenant transaction (defaults when never saved). */
export async function enabledDataScopesTx(tx: Tx, ownerId: string): Promise<DataScope[]> {
  const [row] = await tx<{ data_scopes: string[] | null }[]>`select data_scopes from user_preferences where owner_id = ${ownerId}`;
  return storedDataScopes(row?.data_scopes ?? null);
}

export const enabledDataScopes = (ownerId: string) => withTenantSql(ownerId, (tx) => enabledDataScopesTx(tx, ownerId));

/** Throws ScopeDisabledError (code SCOPE_DISABLED) when the tool's data area is turned off. */
export async function assertToolScope(ownerId: string, tool: string): Promise<void> {
  const blocked = blockedScopeForTool(tool, await enabledDataScopes(ownerId));
  if (blocked) throw new ScopeDisabledError(blocked);
}

export async function getScopeSettings(ownerId: string): Promise<ScopeSettings> {
  const [row] = await withTenantSql(ownerId, (tx) => tx<Row[]>`select data_scopes, agent_defaults, scopes_saved_at from user_preferences where owner_id = ${ownerId}`);
  return scopeSettingsFromRow(row);
}

/** Saves already-validated settings (see parseScopeSettingsBody) and stamps scopes_saved_at. */
export async function saveScopeSettings(ownerId: string, value: Omit<ScopeSettings, "savedAt">): Promise<ScopeSettings> {
  const [row] = await withTenantSql(ownerId, (tx) => tx<Row[]>`
    insert into user_preferences (owner_id, data_scopes, agent_defaults, scopes_saved_at, updated_at)
    values (${ownerId}, ${value.data}::text[], ${tx.json(value.agent)}, now(), now())
    on conflict (owner_id) do update set data_scopes = excluded.data_scopes, agent_defaults = excluded.agent_defaults, scopes_saved_at = now(), updated_at = now()
    returning data_scopes, agent_defaults, scopes_saved_at`);
  return scopeSettingsFromRow(row);
}
