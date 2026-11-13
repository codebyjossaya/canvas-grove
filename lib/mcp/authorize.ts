import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_STATE_LENGTH, parseScope, redirectRegistered, resourceMatches, validChallenge } from "./oauth-policy";
import { mcpServerUrl } from "./origin";
import { getClient, type McpClient } from "./store";

// /oauth/authorize request validation and the consent form's CSRF token.
// Errors about the client or redirect_uri are rendered on the page (never redirected: no open
// redirect). Other errors go back to the already-validated, exactly-registered redirect_uri.

/** `scopes` = what the client asked for; `offerWrite` = whether consent may offer canvas:write (asked for, or no scope given). */
export type AuthorizeRequest = { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[]; resource: string | null; state: string | null; offerWrite: boolean };
export type AuthorizeCheck =
  | { kind: "ok"; client: McpClient; request: AuthorizeRequest }
  | { kind: "fatal"; message: string }
  | { kind: "redirect"; url: string };

const one = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.toString();
}

export async function validateAuthorizeRequest(params: Record<string, unknown>, origin: string): Promise<AuthorizeCheck> {
  for (const value of Object.values(params)) if (Array.isArray(value)) return { kind: "fatal", message: "The request repeats a parameter." };
  const client = await getClient(one(params.client_id));
  if (!client) return { kind: "fatal", message: "This app is not registered with Canvas Grove." };
  const redirectUri = one(params.redirect_uri);
  if (!redirectUri || !redirectRegistered(client.redirectUris, redirectUri)) return { kind: "fatal", message: "The app's return address does not match what it registered, so Grove will not send you back to it." };
  const state = one(params.state) ?? null;
  if (state && state.length > MAX_STATE_LENGTH) return { kind: "fatal", message: "The request is malformed (state is too long)." };
  const back = (error: string, description: string): AuthorizeCheck => ({ kind: "redirect", url: redirectWith(redirectUri, { error, error_description: description, state, iss: origin }) });
  if (one(params.response_type) !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (one(params.code_challenge_method) !== "S256" || !validChallenge(one(params.code_challenge))) return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  const scope = parseScope(one(params.scope));
  if (!scope.ok) return back("invalid_scope", "Only the canvas:read and canvas:write scopes are available.");
  const offerWrite = !one(params.scope) || scope.scopes.includes("canvas:write");
  const resource = one(params.resource) || null;
  if (resource && !resourceMatches(resource, mcpServerUrl(origin))) return back("invalid_target", "Unknown resource.");
  return { kind: "ok", client, request: { clientId: client.clientId, redirectUri, codeChallenge: one(params.code_challenge)!, scopes: scope.scopes, resource, state, offerWrite } };
}

// ------------------------------------------------------------------ consent CSRF token

const CONSENT_TTL_MS = 10 * 60_000;
// Per-process HMAC key (single instance, like the rate limiter). A restart only invalidates open
// consent pages; the user reloads.
const store = globalThis as unknown as { groveMcpConsentKey?: Buffer };
const key = () => (store.groveMcpConsentKey ??= randomBytes(32));

const material = (userId: string, r: AuthorizeRequest, ts: number) =>
  [userId, r.clientId, r.redirectUri, r.codeChallenge, r.scopes.join(" "), r.resource ?? "", r.state ?? "", r.offerWrite ? "w" : "r", String(ts)].join("\n");

/** Token binding the consent form to this Clerk user and this exact request. */
export function consentToken(userId: string, request: AuthorizeRequest, now = Date.now()): string {
  return `${now}.${createHmac("sha256", key()).update(material(userId, request, now)).digest("base64url")}`;
}

export function verifyConsentToken(token: unknown, userId: string, request: AuthorizeRequest, now = Date.now()): boolean {
  if (typeof token !== "string") return false;
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const ts = Number(match[1]);
  if (!(now - ts >= 0 && now - ts <= CONSENT_TTL_MS)) return false;
  const expected = createHmac("sha256", key()).update(material(userId, request, ts)).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], "base64url"));
}

