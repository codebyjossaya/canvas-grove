import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { proxyCanvasFile, proxyErrorResponse } from "@/lib/canvas/file-proxy";

export const instant = false;

/** Streams a Canvas file (by Canvas file id) fetched server-side with the user's Canvas session. `?inline=1` previews safe types. */
export async function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  const session = await auth();
  if (!session.userId) return Response.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const { fileId } = await context.params;
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    return await proxyCanvasFile(await ensureUserForClerk(session.userId), fileId, inline, request.headers.get("if-none-match"));
  } catch (error) { return proxyErrorResponse(error); }
}
