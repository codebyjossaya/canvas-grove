import { auth } from "@clerk/nextjs/server";
import { errorJson, json } from "@/lib/bridge/http";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadCourseSearchIndex } from "@/lib/views/loaders";

// Read-only titles of everything synced for one owned course, for in-course search.
export async function GET(_: Request, context: { params: Promise<{ courseId: string }> }) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const { courseId } = await context.params;
    const result = await loadCourseSearchIndex(await ensureUserForClerk(session.userId), courseId);
    return result ? json(result) : json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
  } catch (error) { return errorJson(error); }
}
