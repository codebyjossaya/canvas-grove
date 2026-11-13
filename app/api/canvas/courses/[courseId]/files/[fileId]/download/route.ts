import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { json } from "@/lib/bridge/http";
import { getCourseFileCanvasId } from "@/lib/courses/content";
import { proxyCanvasFile, proxyErrorResponse } from "@/lib/canvas/file-proxy";

export const instant = false;

// Streams the file through Grove with the user's server-held Canvas session. (It used to
// redirect the browser to Canvas, which only worked on a device already signed in to Canvas.)
export async function GET(request: Request, context: { params: Promise<{ courseId: string; fileId: string }> }) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const ctx = await ensureUserForClerk(session.userId);
    const { courseId, fileId } = await context.params;
    const canvasFileId = await getCourseFileCanvasId(ctx, courseId, fileId);
    if (!canvasFileId) return json({ error: "File not found", code: "FILE_NOT_FOUND" }, 404);
    return await proxyCanvasFile(ctx, canvasFileId, new URL(request.url).searchParams.get("inline") === "1");
  } catch (error) { return proxyErrorResponse(error); }
}
