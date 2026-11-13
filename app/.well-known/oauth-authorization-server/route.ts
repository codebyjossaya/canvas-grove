import { CORS, NO_STORE, corsPreflight, originFor } from "@/lib/mcp/http";
import { SUPPORTED_SCOPES } from "@/lib/mcp/oauth-policy";

export const instant = false;

/** RFC 8414 authorization-server metadata: S256 PKCE only, public clients only, DCR enabled. */
export function GET(request: Request) {
  const origin = originFor(request);
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
    authorization_response_iss_parameter_supported: true,
  }, { headers: { ...NO_STORE, ...CORS } });
}

export const OPTIONS = corsPreflight;
