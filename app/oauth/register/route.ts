import { corsPreflight, oauthError, oauthJson, rateLimited } from "@/lib/mcp/http";
import { MAX_REGISTRATION_BYTES, MCP_LIMITS, clientIp, limit } from "@/lib/mcp/limits";
import { validateRegistration } from "@/lib/mcp/oauth-policy";
import { registerClient } from "@/lib/mcp/store";

export const instant = false;

/**
 * RFC 7591 dynamic client registration. Public clients only (token_endpoint_auth_method "none"),
 * capped per IP, globally per hour, and in total; redirect URIs validated (see oauth-policy.ts).
 */
export async function POST(request: Request) {
  const perIp = limit(MCP_LIMITS.registerIp, clientIp(request.headers));
  if (!perIp.allowed) return rateLimited(perIp.retryAfterSeconds);
  const global = limit(MCP_LIMITS.registerGlobal, "global");
  if (!global.allowed) return rateLimited(global.retryAfterSeconds);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REGISTRATION_BYTES) return oauthError("invalid_client_metadata", "Registration request is too large.", 413);
  const text = await request.text().catch(() => "");
  if (text.length > MAX_REGISTRATION_BYTES) return oauthError("invalid_client_metadata", "Registration request is too large.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return oauthError("invalid_client_metadata", "Body must be JSON."); }
  const checked = validateRegistration(body);
  if (!checked.ok) return oauthError(checked.error, checked.description);
  const client = await registerClient(checked.value);
  if (!client) return oauthError("temporarily_unavailable", "Client registration is closed on this server.", 503);
  return oauthJson({
    client_id: client.clientId,
    client_id_issued_at: Math.floor(new Date(client.createdAt ?? Date.now()).getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "canvas:read",
  }, 201);
}

export const OPTIONS = corsPreflight;
