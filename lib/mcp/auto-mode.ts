import "server-only";
import type postgres from "postgres";
import { withTenantSql } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { canPropose } from "./categories";
import { autoActive, type AutoInput } from "./action-policy";
export { parseAutoInput } from "./action-policy";
import { auditTx } from "./actions";

// Per-connection auto mode. Only reachable from Grove's web API (Clerk session + CSRF); there is no
// MCP tool or bearer path that can read or change it.

type Tx = postgres.TransactionSql;
type Stamp = Date | string | null;
const iso = (value: Stamp) => (value ? new Date(value).toISOString() : null);

export type AutoTarget = {
  kind: "token" | "grant"; id: string; name: string; canPropose: boolean;
  auto: { enabled: boolean; categories: string[]; expiresAt: string | null; usedLastHour: number; usedToday: number };
};

type TargetRow = { kind: "token" | "grant"; id: string; name: string | null; scopes: string[]; enabled: boolean | null; categories: string[] | null; expires_at: Stamp; hour: number; day: number };

const targetsQuery = (tx: Tx, ownerId: string) => tx<TargetRow[]>`
  with conns as (
    select 'token'::text as kind, t.id, t.name, t.scopes, t.created_at from mcp_tokens t
      where t.owner_id = ${ownerId} and t.kind = 'pat' and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
    union all
    select 'grant'::text, g.id, c.client_name, g.scopes, g.created_at from mcp_grants g left join mcp_clients c on c.client_id = g.client_id
      where g.owner_id = ${ownerId} and g.revoked_at is null)
  select x.kind, x.id, x.name, x.scopes, m.enabled, m.categories, m.expires_at,
    (select count(*) from mcp_pending_actions a where a.owner_id = ${ownerId} and coalesce(a.token_id, a.grant_id) = x.id and a.decided_by = 'auto' and a.decided_at > now() - interval '1 hour')::int as hour,
    (select count(*) from mcp_pending_actions a where a.owner_id = ${ownerId} and coalesce(a.token_id, a.grant_id) = x.id and a.decided_by = 'auto' and a.decided_at > now() - interval '1 day')::int as day
  from conns x left join mcp_auto_modes m on m.owner_id = ${ownerId} and coalesce(m.token_id, m.grant_id) = x.id
  order by x.created_at desc`;

const toTarget = (r: TargetRow): AutoTarget => {
  const mode = r.enabled == null ? null : { enabled: r.enabled, categories: r.categories ?? [], expires_at: r.expires_at };
  const active = autoActive(mode);
  return {
    kind: r.kind, id: r.id, name: r.name ?? (r.kind === "token" ? "Access token" : "MCP client"), canPropose: canPropose(r.scopes),
    auto: { enabled: active, categories: r.categories ?? [], expiresAt: active ? iso(r.expires_at) : null, usedLastHour: r.hour, usedToday: r.day },
  };
};

export async function listAutoTargets(ctx: AuthContext): Promise<AutoTarget[]> {
  return withTenantSql(ctx.ownerId, async (tx) => (await targetsQuery(tx, ctx.ownerId)).map(toTarget));
}

export type AutoSetResult = { kind: "ok"; target: AutoTarget } | { kind: "not_found" } | { kind: "cannot_propose" };

/**
 * Turn auto mode on/off for one connection. Turning it off is the kill switch: it also cancels
 * everything still awaiting approval for that connection.
 */
export async function setAutoMode(ctx: AuthContext, kind: "token" | "grant", id: string, input: AutoInput): Promise<AutoSetResult> {
  return withTenantSql(ctx.ownerId, async (tx) => {
    const targets = await targetsQuery(tx, ctx.ownerId);
    const target = targets.find((t) => t.kind === kind && t.id === id);
    if (!target) return { kind: "not_found" as const };
    if (input.enabled && !canPropose(target.scopes)) return { kind: "cannot_propose" as const };
    const tokenId = kind === "token" ? id : null;
    const grantId = kind === "grant" ? id : null;
    const expires = input.enabled && input.durationMinutes != null ? `${input.durationMinutes} minutes` : null;
    const [existing] = await tx<{ id: string }[]>`select id from mcp_auto_modes where owner_id = ${ctx.ownerId} and coalesce(token_id, grant_id) = ${id} for update`;
    if (existing) {
      await tx`update mcp_auto_modes set enabled = ${input.enabled}, categories = ${input.categories}::text[],
        expires_at = case when ${expires}::text is null then null else now() + ${expires}::interval end, updated_at = now() where owner_id = ${ctx.ownerId} and id = ${existing.id}`;
    } else {
      await tx`insert into mcp_auto_modes (owner_id, token_id, grant_id, enabled, categories, expires_at)
        values (${ctx.ownerId}, ${tokenId}, ${grantId}, ${input.enabled}, ${input.categories}::text[], case when ${expires}::text is null then null else now() + ${expires}::interval end)`;
    }
    if (!input.enabled) {
      await tx`update mcp_pending_actions set status = 'cancelled', decided_by = 'system', decided_at = now()
        where owner_id = ${ctx.ownerId} and coalesce(token_id, grant_id) = ${id} and status = 'awaiting_approval'`;
    }
    await auditTx(tx, ctx.ownerId, { tokenId, grantId, clientName: target.name, tool: "auto_mode", outcome: input.enabled ? `enabled:${input.categories.join("+")}:${input.durationMinutes ?? "until_off"}` : "disabled", decidedBy: "you" });
    const [fresh] = (await targetsQuery(tx, ctx.ownerId)).filter((t) => t.kind === kind && t.id === id);
    return { kind: "ok" as const, target: toTarget(fresh) };
  });
}
