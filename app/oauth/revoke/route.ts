import { CORS, NO_STORE, corsPreflight, oauthError, rateLimited, readParams } from "@/lib/mcp/http";
import { MCP_LIMITS, clientKey, limit } from "@/lib/mcp/limits";
import { revokePresentedToken } from "@/lib/mcp/store";

export const instant = false;

/** RFC 7009 revocation. Always 200 for well-formed requests, whether or not the token was valid. */
export async function POST(request: Request) {
  const params = await readParams(request);
  const allowed = limit(MCP_LIMITS.revokeIp, clientKey(params?.client_id, request.headers));
  if (!allowed.allowed) return rateLimited(allowed.retryAfterSeconds);
  if (!params?.token) return oauthError("invalid_request", "token is required.");
  await revokePresentedToken(params.token, params.client_id);
  return new Response(null, { status: 200, headers: { ...NO_STORE, ...CORS } });
}

export const OPTIONS = corsPreflight;
