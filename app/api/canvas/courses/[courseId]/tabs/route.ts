import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { errorJson, json } from "@/lib/bridge/http";
import { listCourseTabs } from "@/lib/courses/content";

export async function GET(_: Request, context: { params: Promise<{ courseId: string }> }) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const { courseId } = await context.params;
    const result = await listCourseTabs(await ensureUserForClerk(session.userId), courseId);
    return result ? json(result) : json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
  } catch (error) { return errorJson(error); }
}
