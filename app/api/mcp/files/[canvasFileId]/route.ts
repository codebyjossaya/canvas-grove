import { proxyCanvasFile, proxyErrorResponse } from "@/lib/canvas/file-proxy";
import { NO_STORE, requireBearer } from "@/lib/mcp/http";
import { ownsCourseFile } from "@/lib/mcp/store";

export const instant = false;

const notFound = () => Response.json({ error: "File not found", code: "NOT_FOUND" }, { status: 404, headers: NO_STORE });

/**
 * File bytes for MCP clients (bearer PAT or OAuth access token, scope canvas:read, per-token rate
 * limit, no CORS). Only files in the token owner's own synced course_files are served; the bytes
 * stream through Grove's Canvas file proxy with the owner's Canvas session. `?inline=1` previews.
 */
export async function GET(request: Request, context: { params: Promise<{ canvasFileId: string }> }) {
  const authed = await requireBearer(request);
  if (authed instanceof Response) return authed;
  const { canvasFileId } = await context.params;
  if (!/^\d{1,20}$/.test(canvasFileId) || !(await ownsCourseFile(authed.ctx.ownerId, canvasFileId))) return notFound();
  const started = Date.now();
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  try {
    const response = await proxyCanvasFile(authed.ctx, canvasFileId, inline);
    console.info(JSON.stringify({ event: "mcp_file", ownerId: authed.ctx.ownerId, status: response.status, ms: Date.now() - started }));
    return response;
  } catch (error) {
    console.info(JSON.stringify({ event: "mcp_file", ownerId: authed.ctx.ownerId, status: "error", ms: Date.now() - started }));
    return proxyErrorResponse(error);
  }
}
