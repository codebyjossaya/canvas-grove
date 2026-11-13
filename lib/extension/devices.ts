import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, withTenantSql } from "@/lib/db";
import { users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/db/auth-context";
import { DEVICE_SCOPE, bearerToken, mintToken, parseToken, secretMatches } from "./device-token";

export const MAX_ACTIVE_DEVICES = 10;
const LAST_SEEN_REFRESH_MS = 60_000;

export type DeviceSummary = { id: string; name: string; prefix: string | null; pairedAt: string | null; lastSeenAt: string | null; userAgent: string | null };
// The shared postgres.js client returns timestamps as strings, not Dates.
type Stamp = Date | string | null;
type Row = { id: string; name: string; credential_prefix: string | null; paired_at: Stamp; last_seen_at: Stamp; user_agent_summary: string | null };
const iso = (value: Stamp) => (value ? new Date(value).toISOString() : null);
const summary = (row: Row): DeviceSummary => ({ id: row.id, name: row.name, prefix: row.credential_prefix, pairedAt: iso(row.paired_at), lastSeenAt: iso(row.last_seen_at), userAgent: row.user_agent_summary });

export class DeviceLimitError extends Error { constructor() { super(`At most ${MAX_ACTIVE_DEVICES} browsers can be connected. Disconnect one first.`); } }

/** Pair a browser: stores only the hash; the token is returned exactly once. */
export async function createDevice(ctx: AuthContext, name: string, userAgent: string | null): Promise<{ device: DeviceSummary; token: string }> {
  const minted = mintToken(ctx.ownerId);
  const device = await withTenantSql(ctx.ownerId, async (tx) => {
    const [{ count }] = await tx<{ count: string }[]>`select count(*)::text as count from extension_devices where owner_id = ${ctx.ownerId} and status = 'active'`;
    if (Number(count) >= MAX_ACTIVE_DEVICES) throw new DeviceLimitError();
    const [row] = await tx<Row[]>`insert into extension_devices (id, owner_id, public_id, name, credential_hash, credential_prefix, scopes, status, paired_at, user_agent_summary)
      values (${minted.deviceId}, ${ctx.ownerId}, ${`dev_${randomBytes(9).toString("base64url")}`}, ${name}, ${minted.secretHash}, ${minted.prefix}, ${[DEVICE_SCOPE]}, 'active', now(), ${userAgent?.slice(0, 160) ?? null})
      returning id, name, credential_prefix, paired_at, last_seen_at, user_agent_summary`;
    return row;
  });
  return { device: summary(device), token: minted.token };
}

export async function listDevices(ctx: AuthContext): Promise<DeviceSummary[]> {
  const rows = await withTenantSql(ctx.ownerId, (tx) => tx<Row[]>`select id, name, credential_prefix, paired_at, last_seen_at, user_agent_summary from extension_devices where owner_id = ${ctx.ownerId} and status = 'active' order by paired_at desc nulls last`);
  return rows.map(summary);
}

/** Revoke by id. The hash is cleared so a leaked token is dead immediately. */
export async function revokeDevice(ownerId: string, deviceId: string): Promise<boolean> {
  const rows = await withTenantSql(ownerId, (tx) => tx`update extension_devices set status = 'revoked', revoked_at = now(), credential_hash = null, updated_at = now() where owner_id = ${ownerId} and id = ${deviceId} and status = 'active' returning id`);
  return rows.length > 0;
}

export type DeviceAuth = { ctx: AuthContext; deviceId: string; deviceName: string };

/** Authenticate `Authorization: Bearer gfe1...`. Returns null for anything wrong, with no detail. */
export async function authenticateExtension(request: Request): Promise<DeviceAuth | null> {
  const parsed = parseToken(bearerToken(request));
  if (!parsed) return null;
  const found = await withTenantSql(parsed.ownerId, async (tx) => {
    const [row] = await tx<{ id: string; name: string; credential_hash: string | null; scopes: string[]; last_seen_at: Stamp }[]>`select id, name, credential_hash, scopes, last_seen_at from extension_devices where owner_id = ${parsed.ownerId} and id = ${parsed.deviceId} and status = 'active' and revoked_at is null`;
    if (!row || !row.scopes.includes(DEVICE_SCOPE) || !secretMatches(parsed.secret, row.credential_hash)) return null;
    if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > LAST_SEEN_REFRESH_MS) await tx`update extension_devices set last_seen_at = now() where owner_id = ${parsed.ownerId} and id = ${row.id}`;
    return row;
  });
  if (!found) return null;
  const [user] = await db.select({ clerkUserId: users.clerkUserId, status: users.status }).from(users).where(eq(users.id, parsed.ownerId)).limit(1);
  if (!user || user.status !== "active") return null;
  return { ctx: { ownerId: parsed.ownerId, clerkUserId: user.clerkUserId }, deviceId: found.id, deviceName: found.name };
}
