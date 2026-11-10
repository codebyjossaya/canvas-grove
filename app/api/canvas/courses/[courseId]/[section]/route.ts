import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { errorJson, json } from "@/lib/bridge/http";
import { courseSections, getCourseSection, type CourseSection } from "@/lib/courses/content";

export async function GET(_: Request, context: { params: Promise<{ courseId: string; section: string }> }) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const { courseId, section } = await context.params;
    if (!courseSections.has(section as CourseSection)) return json({ error: "Course section not found", code: "SECTION_NOT_FOUND" }, 404);
    const result = await getCourseSection(await ensureUserForClerk(session.userId), courseId, section as CourseSection);
    return result ? json(result) : json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
  } catch (error) { return errorJson(error); }
}
