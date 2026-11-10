import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { errorJson, json } from "@/lib/bridge/http";
import { getCourseFileDownload } from "@/lib/courses/content";

export async function GET(_: Request, context: { params: Promise<{ courseId: string; fileId: string }> }) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const { courseId, fileId } = await context.params;
    const url = await getCourseFileDownload(await ensureUserForClerk(session.userId), courseId, fileId);
    if (!url) return json({ error: "File not found", code: "FILE_NOT_FOUND" }, 404);
    return Response.redirect(url, 307);
  } catch (error) { return errorJson(error); }
}
