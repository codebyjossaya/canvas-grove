import "server-only";
import { rateLimitedResponse } from "@/lib/rate-limit";
import { publicOrigin, resourceMetadataUrl } from "./origin";
import { MAX_FORM_BYTES, MCP_LIMITS, limit } from "./limits";
import { authenticateBearer, type BearerAuth } from "./store";
import { bearerToken } from "./token";
import { hasScope } from "./oauth-policy";

// Shared HTTP plumbing for the MCP + OAuth routes.
// CORS is permissive (`*`, never credentials) ONLY on discovery, register, token and revoke.

export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
} as const;

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS });

export function oauthJson(body: unknown, status = 200, cors = true): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...(cors ? CORS : {}) } });
}

export const oauthError = (error: string, description: string, status = 400) => oauthJson({ error, error_description: description }, status);

export function rateLimited(retryAfterSeconds: number, cors = true): Response {
  const response = rateLimitedResponse(retryAfterSeconds);
  if (cors) for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
  return response;
}

/** Public origin for this request (see lib/mcp/origin.ts for the trust order). */
export function originFor(request: Request): string {
  return publicOrigin(request.headers, new URL(request.url).origin) ?? new URL(request.url).origin;
}

/** Reads an OAuth form body (x-www-form-urlencoded, or JSON as a courtesy) with a size cap. */
export async function readParams(request: Request, maxBytes = MAX_FORM_BYTES): Promise<Record<string, string> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  const text = await request.text().catch(() => null);
  if (text == null || text.length > maxBytes) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const body = JSON.parse(text) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch { return null; }
  }
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in out) return null; // RFC 6749 §3.1: parameters must not be repeated
    out[key] = value;
  }
  return out;
}

/** 401 for /mcp-style bearer routes, pointing clients at the protected-resource metadata. */
export function unauthorized(origin: string, presented: boolean): Response {
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl(origin)}"${presented ? ', error="invalid_token", error_description="The access token is invalid or expired"' : ""}`;
  return Response.json({ error: "Authentication required", code: presented ? "INVALID_TOKEN" : "AUTH_REQUIRED" }, { status: 401, headers: { ...NO_STORE, "www-authenticate": challenge } });
}

export function insufficientScope(origin: string, scope: string): Response {
  return Response.json({ error: "Insufficient scope", code: "INSUFFICIENT_SCOPE" }, {
    status: 403, headers: { ...NO_STORE, "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(origin)}", error="insufficient_scope", scope="${scope}"` },
  });
}

/** Bearer auth + scope + per-token rate limit, shared by /mcp and /api/mcp/files. */
export async function requireBearer(request: Request, scope = "canvas:read"): Promise<BearerAuth | Response> {
  const origin = originFor(request);
  const presented = bearerToken(request);
  const authed = presented ? await authenticateBearer(presented) : null;
  if (!authed) return unauthorized(origin, !!presented || request.headers.has("authorization"));
  if (!hasScope(authed.scopes, scope)) return insufficientScope(origin, scope);
  const allowed = limit(MCP_LIMITS.mcpToken, authed.tokenId);
  if (!allowed.allowed) return rateLimited(allowed.retryAfterSeconds, false);
  return authed;
}
