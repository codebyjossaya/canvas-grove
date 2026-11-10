import { auth } from "@clerk/nextjs/server";
import { body, errorJson, json } from "@/lib/bridge/http";
import { executeInHostedSession, hostedSessionStore } from "@/lib/bridge/hosted-browser";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";
import { favoriteFailure, favoriteRequest } from "@/lib/courses/favorites";

export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const authSession = await auth();
  if (!authSession.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const { courseId } = await context.params;
    const input = await body(request);
    if (typeof input.active !== "boolean") return json({ error: "active must be a boolean", code: "INVALID_REQUEST" }, 400);
    const key = request.headers.get("x-idempotency-key") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) return json({ error: "A valid idempotency key is required", code: "INVALID_IDEMPOTENCY_KEY" }, 400);
    const repo = tenantRepository(await ensureUserForClerk(authSession.userId));
    const course = await repo.getCourse(courseId);
    if (!course) return json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
    const sessions = await hostedSessionStore.listForOwner(authSession.userId);
    const session = sessions.find((item) => item.state === "active" && item.providerSessionId);
    if (!session) return json({ error: "Canvas needs to be reconnected before course visibility can change.", code: "CANVAS_AUTH_EXPIRED" }, 401);
    const result = await executeInHostedSession({
      ownerId: authSession.userId,
      sessionId: session.id,
      idempotencyKey: key,
      request: favoriteRequest(course.canvasCourseId, input.active),
    });
    if (!result.ok) {
      const failure = favoriteFailure(result.status, result.authRequired);
      return json({ error: failure.error, code: failure.code }, failure.status);
    }
    const updated = await repo.setCourseFavorite(course.id, input.active);
    if (!updated) return json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
    return json({ course: { id: updated.id, active: updated.favorite }, replay: result.replay });
  } catch (error) { return errorJson(error); }
}
