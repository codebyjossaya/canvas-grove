import "server-only";
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, withTenantSql } from "@/lib/db";
import { users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/db/auth-context";
import { mintCode, mintToken, parseCode, parseToken, safeEqual, secretMatches } from "./token";
import {
  ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS, bearerUsable, checkCodeExchange, checkRefresh, redirectRegistered,
  scopeString, validChallenge, type OAuthErrorCode, type Registration,
} from "./oauth-policy";
import { MAX_ACTIVE_PATS, MAX_CLIENTS } from "./limits";

// Persistence for Grove's MCP credentials. Every tenant table is touched only inside
// withTenantSql(ownerId) (forced RLS). mcp_clients is ownerless public metadata (no RLS).
// postgres.js returns timestamps as strings: always normalise with iso().

type Tx = postgres.TransactionSql;
type Stamp = Date | string | null;
const iso = (value: Stamp) => (value ? new Date(value).toISOString() : null);
const LAST_USED_REFRESH_MS = 60_000;
const CLIENT_ID = /^gmcl_[A-Za-z0-9_-]{22}$/;

// ------------------------------------------------------------------ clients (RFC 7591)

export type McpClient = { clientId: string; clientName: string; redirectUris: string[]; createdAt: string | null };
type ClientRow = { client_id: string; client_name: string; redirect_uris: string[]; created_at: Stamp };
const toClient = (row: ClientRow): McpClient => ({ clientId: row.client_id, clientName: row.client_name, redirectUris: row.redirect_uris, createdAt: iso(row.created_at) });

/** Registers a public client. Returns null when the global client cap is reached. */
export async function registerClient(input: Registration): Promise<McpClient | null> {
  const clientId = `gmcl_${randomBytes(16).toString("base64url")}`;
  const sql = db.$client;
  // Grant-less registrations older than a day are dropped before counting toward the cap. A client
  // that was ever granted has last_granted_at set (and the grant FK is ON DELETE RESTRICT).
  await sql`delete from mcp_clients where last_granted_at is null and created_at < now() - interval '24 hours'`.catch(() => undefined);
  const [row] = await sql<ClientRow[]>`insert into mcp_clients (client_id, client_name, redirect_uris)
    select ${clientId}, ${input.clientName}, ${input.redirectUris}::text[] where (select count(*) from mcp_clients) < ${MAX_CLIENTS}
    returning client_id, client_name, redirect_uris, created_at`;
  return row ? toClient(row) : null;
}

export async function getClient(clientId: unknown): Promise<McpClient | null> {
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return null;
  const [row] = await db.$client<ClientRow[]>`select client_id, client_name, redirect_uris, created_at from mcp_clients where client_id = ${clientId}`;
  return row ? toClient(row) : null;
}

// ------------------------------------------------------------------ authorization codes + grants

export type CodeInput = { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[]; resource: string | null };

/**
 * Called by the consent POST after the signed-in user approved: finds or creates the user's grant
 * for this client and stores a single-use, 5-minute code bound to client, redirect_uri, PKCE
 * challenge and resource. Returns the code (shown once, to the redirect only).
 */
export async function createAuthorizationCode(ownerId: string, input: CodeInput): Promise<string> {
  const client = await getClient(input.clientId);
  if (!client || !redirectRegistered(client.redirectUris, input.redirectUri) || !validChallenge(input.codeChallenge)) throw new Error("Invalid authorization request");
  const minted = mintCode(ownerId);
  await withTenantSql(ownerId, async (tx) => {
    let [grant] = await tx<{ id: string }[]>`update mcp_grants set scopes = ${input.scopes}::text[] where owner_id = ${ownerId} and client_id = ${client.clientId} and revoked_at is null returning id`;
    if (!grant) [grant] = await tx<{ id: string }[]>`insert into mcp_grants (owner_id, client_id, scopes) values (${ownerId}, ${client.clientId}, ${input.scopes}::text[]) returning id`;
    await tx`update mcp_clients set last_granted_at = now() where client_id = ${client.clientId}`;
    await tx`delete from mcp_auth_codes where owner_id = ${ownerId} and expires_at < now() - interval '1 day'`;
    await tx`insert into mcp_auth_codes (id, owner_id, grant_id, client_id, code_hash, redirect_uri, code_challenge, resource, scopes, expires_at)
      values (${minted.id}, ${ownerId}, ${grant.id}, ${client.clientId}, ${minted.hash}, ${input.redirectUri}, ${input.codeChallenge}, ${input.resource}, ${input.scopes}::text[], now() + ${`${CODE_TTL_MS / 1000} seconds`}::interval)`;
  });
  return minted.value;
}

export type TokenResponse = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };
export type OAuthFailure = { error: OAuthErrorCode; error_description: string };
export const isFailure = (value: TokenResponse | OAuthFailure): value is OAuthFailure => "error" in value;

async function issuePair(tx: Tx, ownerId: string, grantId: string, scopes: string[]): Promise<TokenResponse> {
  const access = mintToken(ownerId);
  const refresh = mintToken(ownerId);
  await tx`insert into mcp_tokens (id, owner_id, kind, grant_id, secret_hash, prefix, scopes, expires_at) values
    (${access.id}, ${ownerId}, 'access', ${grantId}, ${access.hash}, ${access.prefix}, ${scopes}::text[], now() + ${`${ACCESS_TTL_MS / 1000} seconds`}::interval),
    (${refresh.id}, ${ownerId}, 'refresh', ${grantId}, ${refresh.hash}, ${refresh.prefix}, ${scopes}::text[], now() + ${`${REFRESH_TTL_MS / 1000} seconds`}::interval)`;
  await tx`update mcp_grants set last_used_at = now() where owner_id = ${ownerId} and id = ${grantId}`;
  // Old rotated/expired rows of this grant are no longer needed for reuse detection after expiry.
  await tx`delete from mcp_tokens where owner_id = ${ownerId} and grant_id = ${grantId} and expires_at < now() - interval '1 day'`;
  return { access_token: access.value, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh.value, scope: scopeString(scopes) };
}

/** Ending a connection (PAT or grant) cancels its pending actions, ends auto mode and quiz sessions. */
async function endConnectionTx(tx: Tx, ownerId: string, connectionId: string) {
  await tx`update mcp_pending_actions set status = 'cancelled', decided_by = 'system', decided_at = now() where owner_id = ${ownerId} and coalesce(token_id, grant_id) = ${connectionId} and status = 'awaiting_approval'`;
  await tx`update mcp_auto_modes set enabled = false, updated_at = now() where owner_id = ${ownerId} and coalesce(token_id, grant_id) = ${connectionId} and enabled`;
  await tx`update mcp_quiz_sessions set ended_at = now() where owner_id = ${ownerId} and coalesce(token_id, grant_id) = ${connectionId} and ended_at is null`;
}

async function revokeGrantTx(tx: Tx, ownerId: string, grantId: string): Promise<boolean> {
  const rows = await tx`update mcp_grants set revoked_at = now() where owner_id = ${ownerId} and id = ${grantId} and revoked_at is null returning id`;
  await endConnectionTx(tx, ownerId, grantId);
  await tx`update mcp_tokens set revoked_at = coalesce(revoked_at, now()), secret_hash = null where owner_id = ${ownerId} and grant_id = ${grantId}`;
  await tx`delete from mcp_auth_codes where owner_id = ${ownerId} and grant_id = ${grantId}`;
  return rows.length > 0;
}

const userActive = async (tx: Tx, ownerId: string) => {
  const [user] = await tx<{ status: string }[]>`select status from users where id = ${ownerId}`;
  return user?.status === "active";
};

const failure = (error: OAuthErrorCode, description: string): OAuthFailure => ({ error, error_description: description });

export type CodeExchange = { code: unknown; clientId: unknown; redirectUri: unknown; codeVerifier: unknown; resource: unknown };

export async function exchangeAuthorizationCode(req: CodeExchange, serverUrl: string): Promise<TokenResponse | OAuthFailure> {
  const parsed = parseCode(req.code);
  if (!parsed) return failure("invalid_grant", "Invalid authorization code.");
  return withTenantSql(parsed.ownerId, async (tx) => {
    const [row] = await tx<(Parameters<typeof checkCodeExchange>[0] & { id: string; grant_id: string; code_hash: string; scopes: string[] })[]>`
      select c.id, c.grant_id, c.code_hash, c.client_id, c.redirect_uri, c.code_challenge, c.resource, c.scopes, c.expires_at, c.used_at, g.revoked_at as grant_revoked_at
      from mcp_auth_codes c join mcp_grants g on g.owner_id = c.owner_id and g.id = c.grant_id
      where c.owner_id = ${parsed.ownerId} and c.id = ${parsed.id} for update of c`;
    const matched = row && secretMatches(parsed.secret, row.code_hash) ? row : null;
    const decision = checkCodeExchange(matched, req, serverUrl);
    if (!decision.ok) {
      if (decision.replay && matched) await revokeGrantTx(tx, parsed.ownerId, matched.grant_id);
      return failure(decision.error, decision.description);
    }
    await tx`update mcp_auth_codes set used_at = now() where owner_id = ${parsed.ownerId} and id = ${matched!.id}`;
    if (!(await userActive(tx, parsed.ownerId))) return failure("invalid_grant", "Account is not active.");
    return issuePair(tx, parsed.ownerId, matched!.grant_id, matched!.scopes);
  });
}

export async function refreshTokens(req: { refreshToken: unknown; clientId: unknown; scope: unknown }): Promise<TokenResponse | OAuthFailure> {
  const parsed = parseToken(req.refreshToken);
  if (!parsed) return failure("invalid_grant", "Invalid refresh token.");
  return withTenantSql(parsed.ownerId, async (tx) => {
    const [row] = await tx<(Parameters<typeof checkRefresh>[0] & { id: string; grant_id: string; secret_hash: string | null })[]>`
      select t.id, t.kind, t.grant_id, t.secret_hash, t.scopes, t.expires_at, t.consumed_at, t.revoked_at, g.client_id, g.revoked_at as grant_revoked_at
      from mcp_tokens t join mcp_grants g on g.owner_id = t.owner_id and g.id = t.grant_id
      where t.owner_id = ${parsed.ownerId} and t.id = ${parsed.id} for update of t`;
    const matched = row && secretMatches(parsed.secret, row.secret_hash) ? row : null;
    const decision = checkRefresh(matched, req);
    if (!decision.ok) {
      if (decision.replay && matched) await revokeGrantTx(tx, parsed.ownerId, matched.grant_id);
      return failure(decision.error, decision.description);
    }
    await tx`update mcp_tokens set consumed_at = now() where owner_id = ${parsed.ownerId} and id = ${matched!.id}`;
    if (!(await userActive(tx, parsed.ownerId))) return failure("invalid_grant", "Account is not active.");
    return issuePair(tx, parsed.ownerId, matched!.grant_id, decision.scopes);
  });
}

/**
 * RFC 7009 revocation by the token holder. Refresh tokens revoke the whole grant; access tokens and
 * PATs revoke themselves. Unknown/invalid tokens and client mismatches are silently ignored.
 */
export async function revokePresentedToken(token: unknown, clientId: unknown): Promise<void> {
  const parsed = parseToken(token);
  if (!parsed) return;
  await withTenantSql(parsed.ownerId, async (tx) => {
    const [row] = await tx<{ id: string; kind: string; grant_id: string | null; secret_hash: string | null; client_id: string | null }[]>`
      select t.id, t.kind, t.grant_id, t.secret_hash, g.client_id from mcp_tokens t left join mcp_grants g on g.owner_id = t.owner_id and g.id = t.grant_id
      where t.owner_id = ${parsed.ownerId} and t.id = ${parsed.id} for update of t`;
    if (!row || !secretMatches(parsed.secret, row.secret_hash)) return;
    if (row.grant_id && typeof clientId === "string" && clientId && !safeEqual(clientId, row.client_id)) return;
    if (row.kind === "refresh" && row.grant_id) { await revokeGrantTx(tx, parsed.ownerId, row.grant_id); return; }
    await tx`update mcp_tokens set revoked_at = now(), secret_hash = null where owner_id = ${parsed.ownerId} and id = ${row.id}`;
    if (row.kind === "pat") await endConnectionTx(tx, parsed.ownerId, row.id);
  });
}

// ------------------------------------------------------------------ bearer authentication (/mcp)

export type BearerAuth = { ctx: AuthContext; tokenId: string; kind: "pat" | "access"; scopes: string[]; grantId: string | null; clientName: string };

/** Authenticates a `gmt1` PAT or OAuth access token. Null for anything wrong, with no detail. */
export async function authenticateBearer(value: string | null): Promise<BearerAuth | null> {
  const parsed = parseToken(value);
  if (!parsed) return null;
  const found = await withTenantSql(parsed.ownerId, async (tx) => {
    const [row] = await tx<{ id: string; kind: string; grant_id: string | null; secret_hash: string | null; scopes: string[]; expires_at: Stamp; revoked_at: Stamp; last_used_at: Stamp; grant_revoked_at: Stamp; client_name: string | null; name: string | null }[]>`
      select t.id, t.kind, t.grant_id, t.secret_hash, t.scopes, t.expires_at, t.revoked_at, t.last_used_at, g.revoked_at as grant_revoked_at, c.client_name, t.name
      from mcp_tokens t left join mcp_grants g on g.owner_id = t.owner_id and g.id = t.grant_id left join mcp_clients c on c.client_id = g.client_id
      where t.owner_id = ${parsed.ownerId} and t.id = ${parsed.id} and t.kind in ('pat', 'access')`;
    if (!row || !secretMatches(parsed.secret, row.secret_hash) || !bearerUsable(row)) return null;
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > LAST_USED_REFRESH_MS) {
      await tx`update mcp_tokens set last_used_at = now() where owner_id = ${parsed.ownerId} and id = ${row.id}`;
      if (row.grant_id) await tx`update mcp_grants set last_used_at = now() where owner_id = ${parsed.ownerId} and id = ${row.grant_id}`;
    }
    return row;
  });
  if (!found) return null;
  const [user] = await db.select({ clerkUserId: users.clerkUserId, status: users.status }).from(users).where(eq(users.id, parsed.ownerId)).limit(1);
  if (!user || user.status !== "active") return null;
  return { ctx: { ownerId: parsed.ownerId, clerkUserId: user.clerkUserId }, tokenId: found.id, kind: found.kind as "pat" | "access", scopes: found.scopes, grantId: found.grant_id, clientName: (found.kind === "pat" ? found.name : found.client_name) ?? (found.kind === "pat" ? "Access token" : "MCP client") };
}

// ------------------------------------------------------------------ personal access tokens + Settings API

export type TokenSummary = { id: string; name: string; prefix: string | null; scopes: string[]; createdAt: string | null; lastUsedAt: string | null; expiresAt: string | null };
export type GrantSummary = { id: string; clientName: string; scopes: string[]; createdAt: string | null; lastUsedAt: string | null };
type PatRow = { id: string; name: string | null; prefix: string | null; scopes: string[]; created_at: Stamp; last_used_at: Stamp; expires_at: Stamp };
const patSummary = (row: PatRow): TokenSummary => ({ id: row.id, name: row.name ?? "Token", prefix: row.prefix, scopes: row.scopes, createdAt: iso(row.created_at), lastUsedAt: iso(row.last_used_at), expiresAt: iso(row.expires_at) });

export class TokenLimitError extends Error { constructor() { super(`At most ${MAX_ACTIVE_PATS} access tokens can be active. Revoke one first.`); } }

/** Creates a PAT. Only the hash is stored; the token is returned exactly once. */
export async function createPat(ctx: AuthContext, name: string, expiresInDays: number | null, allowActions = false): Promise<{ token: string; item: TokenSummary }> {
  const minted = mintToken(ctx.ownerId);
  const row = await withTenantSql(ctx.ownerId, async (tx) => {
    // Serialize PAT creation per owner so concurrent requests cannot exceed the cap.
    await tx`select pg_advisory_xact_lock(hashtext(${`mcp-pat:${ctx.ownerId}`}))`;
    const [{ count }] = await tx<{ count: string }[]>`select count(*)::text as count from mcp_tokens where owner_id = ${ctx.ownerId} and kind = 'pat' and revoked_at is null and (expires_at is null or expires_at > now())`;
    if (Number(count) >= MAX_ACTIVE_PATS) throw new TokenLimitError();
    const expires = expiresInDays == null ? null : `${expiresInDays} days`;
    const [created] = await tx<PatRow[]>`insert into mcp_tokens (id, owner_id, kind, name, secret_hash, prefix, scopes, expires_at)
      values (${minted.id}, ${ctx.ownerId}, 'pat', ${name}, ${minted.hash}, ${minted.prefix}, ${allowActions ? ["canvas:read", "canvas:write"] : ["canvas:read"]}::text[], case when ${expires}::text is null then null else now() + ${expires}::interval end)
      returning id, name, prefix, scopes, created_at, last_used_at, expires_at`;
    return created;
  });
  return { token: minted.value, item: patSummary(row) };
}

export async function listConnections(ctx: AuthContext): Promise<{ tokens: TokenSummary[]; grants: GrantSummary[] }> {
  return withTenantSql(ctx.ownerId, async (tx) => {
    const tokens = await tx<PatRow[]>`select id, name, prefix, scopes, created_at, last_used_at, expires_at from mcp_tokens
      where owner_id = ${ctx.ownerId} and kind = 'pat' and revoked_at is null and (expires_at is null or expires_at > now()) order by created_at desc`;
    const grants = await tx<{ id: string; client_name: string | null; scopes: string[]; created_at: Stamp; last_used_at: Stamp }[]>`
      select g.id, c.client_name, g.scopes, g.created_at, g.last_used_at from mcp_grants g left join mcp_clients c on c.client_id = g.client_id
      where g.owner_id = ${ctx.ownerId} and g.revoked_at is null order by g.created_at desc`;
    return {
      tokens: tokens.map(patSummary),
      grants: grants.map((g) => ({ id: g.id, clientName: g.client_name ?? "MCP client", scopes: g.scopes, createdAt: iso(g.created_at), lastUsedAt: iso(g.last_used_at) })),
    };
  });
}

/** Revoke a PAT by id. The hash is cleared so a leaked token is dead immediately. */
export async function revokePat(ownerId: string, tokenId: string): Promise<boolean> {
  return withTenantSql(ownerId, async (tx) => {
    const rows = await tx`update mcp_tokens set revoked_at = now(), secret_hash = null where owner_id = ${ownerId} and id = ${tokenId} and kind = 'pat' and revoked_at is null returning id`;
    if (rows.length) await endConnectionTx(tx, ownerId, tokenId);
    return rows.length > 0;
  });
}

/** Revoke an OAuth grant and every token and code issued under it. */
export async function revokeGrant(ownerId: string, grantId: string): Promise<boolean> {
  return withTenantSql(ownerId, (tx) => revokeGrantTx(tx, ownerId, grantId));
}

/** True when the Canvas file is one of the owner's own synced course files. */
export async function ownsCourseFile(ownerId: string, canvasFileId: string): Promise<boolean> {
  const rows = await withTenantSql(ownerId, (tx) => tx`select 1 from course_files f join courses c on c.owner_id = f.owner_id and c.id = f.course_id
    where f.owner_id = ${ownerId} and f.canvas_file_id = ${canvasFileId} and f.deleted_at is null and c.deleted_at is null limit 1`);
  return rows.length > 0;
}
