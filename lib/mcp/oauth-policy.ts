import { createHash } from "node:crypto";
import { safeEqual } from "./token";

// OAuth 2.1 rules for Grove's MCP authorization server. Pure: every decision the DB layer makes
// about codes and refresh tokens goes through these functions so the lifecycle is unit-tested.

/** canvas:write (phase 2) lets a connection PROPOSE actions; they still need approval or auto mode. */
export const SUPPORTED_SCOPES = ["canvas:read", "canvas:write"] as const;
export const DEFAULT_SCOPES = ["canvas:read"];

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const CODE_TTL_MS = 5 * 60_000;
export const PAT_EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_PAT_EXPIRY_DAYS = 90;

export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 512;
export const MAX_CLIENT_NAME = 100;
export const MAX_STATE_LENGTH = 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ScopeResult = { ok: true; scopes: string[] } | { ok: false };

/** Space-delimited scope string. Absent/empty means the default; anything unknown (incl. reserved) fails. */
export function parseScope(value: unknown): ScopeResult {
  if (value == null || value === "") return { ok: true, scopes: [...DEFAULT_SCOPES] };
  if (typeof value !== "string" || value.length > 200) return { ok: false };
  const scopes = [...new Set(value.split(" ").filter(Boolean))];
  if (!scopes.length) return { ok: true, scopes: [...DEFAULT_SCOPES] };
  return scopes.every((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s)) ? { ok: true, scopes } : { ok: false };
}

/** Scopes granted at consent: read always; write only when it was offered AND the user ticked the box. */
export const grantedScopes = (offerWrite: boolean, allowActions: boolean) => (offerWrite && allowActions ? ["canvas:read", "canvas:write"] : ["canvas:read"]);

export const scopeString = (scopes: string[]) => scopes.join(" ");
export const hasScope = (scopes: string[], needed: string) => scopes.includes(needed);

/** PKCE S256: BASE64URL(SHA256(verifier)). */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const validChallenge = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const validVerifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  return validVerifier(verifier) && validChallenge(challenge) && safeEqual(pkceChallenge(verifier), challenge);
}

/**
 * A redirect URI a client may register: https anywhere, or http only on a loopback host.
 * No fragments, credentials, whitespace or control characters. The string is kept verbatim and
 * matched exactly (byte for byte) at authorize and token time.
 */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_REDIRECT_URI_LENGTH || !/^[\x21-\x7e]+$/.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash || value.includes("#") || url.username || url.password || !url.hostname) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

export const redirectRegistered = (registered: string[], candidate: unknown) =>
  typeof candidate === "string" && registered.some((uri) => uri === candidate);

export type Registration = { clientName: string; redirectUris: string[] };
export type RegistrationResult = { ok: true; value: Registration } | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/**
 * RFC 7591 request validation. Grove only issues public clients: any requested
 * token_endpoint_auth_method is replaced by "none" (RFC 7591 lets the server substitute values).
 */
export function validateRegistration(body: unknown): RegistrationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_client_metadata", description: "Body must be a JSON object." };
  const meta = body as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) return { ok: false, error: "invalid_redirect_uri", description: `Provide 1 to ${MAX_REDIRECT_URIS} redirect_uris.` };
  if (!uris.every(validRedirectUri)) return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must be https, or http on localhost/127.0.0.1/[::1], without fragments." };
  if (meta.grant_types !== undefined && (!Array.isArray(meta.grant_types) || !meta.grant_types.every((g) => g === "authorization_code" || g === "refresh_token")))
    return { ok: false, error: "invalid_client_metadata", description: "Only authorization_code and refresh_token grants are supported." };
  if (meta.response_types !== undefined && (!Array.isArray(meta.response_types) || !meta.response_types.every((r) => r === "code")))
    return { ok: false, error: "invalid_client_metadata", description: "Only the code response type is supported." };
  if (meta.client_name !== undefined && typeof meta.client_name !== "string") return { ok: false, error: "invalid_client_metadata", description: "client_name must be a string." };
  if (meta.scope !== undefined && !parseScope(meta.scope).ok) return { ok: false, error: "invalid_client_metadata", description: "Unsupported scope." };
  const name = typeof meta.client_name === "string" ? meta.client_name.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_CLIENT_NAME) : "";
  return { ok: true, value: { clientName: name || "MCP client", redirectUris: [...new Set(uris as string[])] } };
}

const trimSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);

/** RFC 8707: when a resource is supplied it must be this server's MCP URL (one trailing slash tolerated). */
export function resourceMatches(resource: unknown, serverUrl: string): boolean {
  if (resource == null || resource === "") return true;
  return typeof resource === "string" && trimSlash(resource) === trimSlash(serverUrl);
}

/** PAT expiry choice: 30 / 90 / 365 days or null (never). undefined means invalid input. */
export function patExpiryDays(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return DEFAULT_PAT_EXPIRY_DAYS;
  return (PAT_EXPIRY_DAYS as readonly number[]).includes(value as number) ? (value as number) : undefined;
}

type Stamp = Date | string | null | undefined;
const time = (value: Stamp) => (value ? new Date(value).getTime() : NaN);

export type OAuthErrorCode = "invalid_request" | "invalid_grant" | "invalid_scope" | "invalid_target" | "invalid_client";
export type Decision<T = object> = ({ ok: true } & T) | { ok: false; error: OAuthErrorCode; description: string; replay?: boolean };

export type CodeRow = { client_id: string; redirect_uri: string; code_challenge: string; resource: string | null; expires_at: Stamp; used_at: Stamp; grant_revoked_at: Stamp };
export type CodeRequest = { clientId: unknown; redirectUri: unknown; codeVerifier: unknown; resource: unknown };

/**
 * Authorization-code exchange. `row` is null unless the presented secret already matched the hash.
 * A second use is reported as `replay` so the caller revokes the grant (RFC 6749 §4.1.2).
 */
export function checkCodeExchange(row: CodeRow | null, req: CodeRequest, serverUrl: string, now = Date.now()): Decision {
  if (!row) return { ok: false, error: "invalid_grant", description: "Invalid authorization code." };
  if (row.used_at) return { ok: false, error: "invalid_grant", description: "Authorization code already used.", replay: true };
  if (row.grant_revoked_at) return { ok: false, error: "invalid_grant", description: "Authorization was revoked." };
  if (!(time(row.expires_at) > now)) return { ok: false, error: "invalid_grant", description: "Authorization code expired." };
  if (typeof req.clientId !== "string" || !safeEqual(req.clientId, row.client_id)) return { ok: false, error: "invalid_grant", description: "Code was issued to another client." };
  if (typeof req.redirectUri !== "string" || req.redirectUri !== row.redirect_uri) return { ok: false, error: "invalid_grant", description: "redirect_uri does not match." };
  if (!verifyPkce(req.codeVerifier, row.code_challenge)) return { ok: false, error: "invalid_grant", description: "PKCE verification failed." };
  if (req.resource != null && req.resource !== "") {
    if (!resourceMatches(req.resource, serverUrl)) return { ok: false, error: "invalid_target", description: "Unknown resource." };
    if (row.resource && !resourceMatches(req.resource, row.resource)) return { ok: false, error: "invalid_target", description: "Resource differs from the authorization request." };
  }
  return { ok: true };
}

export type RefreshRow = { kind: string; client_id: string; scopes: string[]; expires_at: Stamp; consumed_at: Stamp; revoked_at: Stamp; grant_revoked_at: Stamp };
export type RefreshRequest = { clientId: unknown; scope: unknown };

/**
 * Refresh-token rotation. `row` is null unless the secret matched. A consumed token presented again
 * is `replay` (reuse detection): the caller revokes the whole grant.
 */
export function checkRefresh(row: RefreshRow | null, req: RefreshRequest, now = Date.now()): Decision<{ scopes: string[] }> {
  if (!row || row.kind !== "refresh") return { ok: false, error: "invalid_grant", description: "Invalid refresh token." };
  if (row.revoked_at || row.grant_revoked_at) return { ok: false, error: "invalid_grant", description: "Refresh token was revoked." };
  if (row.consumed_at) return { ok: false, error: "invalid_grant", description: "Refresh token reuse detected; the authorization was revoked.", replay: true };
  if (!(time(row.expires_at) > now)) return { ok: false, error: "invalid_grant", description: "Refresh token expired." };
  if (typeof req.clientId !== "string" || !safeEqual(req.clientId, row.client_id)) return { ok: false, error: "invalid_grant", description: "Refresh token was issued to another client." };
  if (req.scope == null || req.scope === "") return { ok: true, scopes: row.scopes };
  const parsed = parseScope(req.scope);
  if (!parsed.ok || !parsed.scopes.every((s) => row.scopes.includes(s))) return { ok: false, error: "invalid_scope", description: "Requested scope exceeds the original grant." };
  return { ok: true, scopes: parsed.scopes };
}

/** Bearer credential check for /mcp after the secret matched. */
export type BearerRow = { kind: string; expires_at: Stamp; revoked_at: Stamp; grant_revoked_at: Stamp };
export function bearerUsable(row: BearerRow | null, now = Date.now()): boolean {
  if (!row || (row.kind !== "pat" && row.kind !== "access") || row.revoked_at || row.grant_revoked_at) return false;
  return row.expires_at == null || time(row.expires_at) > now;
}
