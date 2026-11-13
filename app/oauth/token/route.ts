import { corsPreflight, oauthError, oauthJson, originFor, rateLimited, readParams } from "@/lib/mcp/http";
import { MCP_LIMITS, clientKey, limit } from "@/lib/mcp/limits";
import { mcpServerUrl } from "@/lib/mcp/origin";
import { resourceMatches } from "@/lib/mcp/oauth-policy";
import { exchangeAuthorizationCode, isFailure, refreshTokens } from "@/lib/mcp/store";

export const instant = false;

/** OAuth 2.1 token endpoint: authorization_code (PKCE S256 required) and refresh_token (rotating). */
export async function POST(request: Request) {
  const params = await readParams(request);
  const allowed = limit(MCP_LIMITS.tokenIp, clientKey(params?.client_id, request.headers));
  if (!allowed.allowed) return rateLimited(allowed.retryAfterSeconds);
  if (!params) return oauthError("invalid_request", "Malformed request body.");
  const serverUrl = mcpServerUrl(originFor(request));
  if (!params.client_id) return oauthError("invalid_request", "client_id is required.");

  let result;
  if (params.grant_type === "authorization_code") {
    if (!params.code || !params.redirect_uri || !params.code_verifier) return oauthError("invalid_request", "code, redirect_uri and code_verifier are required.");
    result = await exchangeAuthorizationCode({ code: params.code, clientId: params.client_id, redirectUri: params.redirect_uri, codeVerifier: params.code_verifier, resource: params.resource }, serverUrl);
  } else if (params.grant_type === "refresh_token") {
    if (!params.refresh_token) return oauthError("invalid_request", "refresh_token is required.");
    if (!resourceMatches(params.resource, serverUrl)) return oauthError("invalid_target", "Unknown resource.");
    result = await refreshTokens({ refreshToken: params.refresh_token, clientId: params.client_id, scope: params.scope });
  } else {
    return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  }
  if (isFailure(result)) return oauthError(result.error, result.error_description, 400);
  return oauthJson(result);
}

export const OPTIONS = corsPreflight;
