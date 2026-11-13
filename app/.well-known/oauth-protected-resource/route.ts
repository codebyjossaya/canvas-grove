import { CORS, NO_STORE, corsPreflight, originFor } from "@/lib/mcp/http";
import { mcpServerUrl } from "@/lib/mcp/origin";
import { SUPPORTED_SCOPES } from "@/lib/mcp/oauth-policy";

export const instant = false;

/** RFC 9728 protected-resource metadata for Grove's MCP server. */
export function GET(request: Request) {
  const origin = originFor(request);
  return Response.json({
    resource: mcpServerUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Canvas Grove",
  }, { headers: { ...NO_STORE, ...CORS } });
}

export const OPTIONS = corsPreflight;
