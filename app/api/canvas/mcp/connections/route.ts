import { reply, requireWebUser } from "@/lib/extension/http";
import { originFor } from "@/lib/mcp/http";
import { mcpServerUrl } from "@/lib/mcp/origin";
import { listConnections } from "@/lib/mcp/store";
import { getScopeSettings } from "@/lib/scopes/store";

export const instant = false;

/** Settings: the MCP server URL plus the user's personal access tokens and OAuth-connected apps. */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const [{ tokens, grants }, settings] = await Promise.all([listConnections(ctx), getScopeSettings(ctx.ownerId)]);
  // `defaults`: what a new connection gets unless the user changes it (access) and the auto-mode
  // categories to preselect; auto mode itself still needs the explicit per-connection toggle.
  return reply({ serverUrl: mcpServerUrl(originFor(request)), tokens, grants, defaults: settings.agent });
}
