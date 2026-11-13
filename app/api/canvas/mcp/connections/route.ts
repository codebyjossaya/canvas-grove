import { reply, requireWebUser } from "@/lib/extension/http";
import { originFor } from "@/lib/mcp/http";
import { mcpServerUrl } from "@/lib/mcp/origin";
import { listConnections } from "@/lib/mcp/store";

export const instant = false;

/** Settings: the MCP server URL plus the user's personal access tokens and OAuth-connected apps. */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { tokens, grants } = await listConnections(ctx);
  return reply({ serverUrl: mcpServerUrl(originFor(request)), tokens, grants });
}
