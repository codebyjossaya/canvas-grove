import { auth } from "@clerk/nextjs/server";
import { body, errorJson, json } from "@/lib/bridge/http";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { deleteGradeScenario, listGradeScenarios, saveGradeScenario } from "@/lib/grades/service";

export async function GET(request: Request) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  const courseId = new URL(request.url).searchParams.get("courseId");
  if (!courseId) return json({ error: "courseId is required", code: "INVALID_REQUEST" }, 400);
  try {
    const scenarios = await listGradeScenarios(await ensureUserForClerk(session.userId), courseId);
    return scenarios ? json({ scenarios }) : json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
  } catch (error) { return errorJson(error); }
}
export async function POST(request: Request) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const input = await body(request);
    if (typeof input.courseId !== "string" || typeof input.name !== "string") return json({ error: "courseId and name are required", code: "INVALID_REQUEST" }, 400);
    const scenario = await saveGradeScenario(await ensureUserForClerk(session.userId), { id: typeof input.id === "string" ? input.id : undefined, courseId: input.courseId, name: input.name, scores: input.scores });
    return scenario ? json({ scenario }, 201) : json({ error: "Course not found", code: "COURSE_NOT_FOUND" }, 404);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_")) return json({ error: "The grade scenario is invalid.", code: error.message }, 400);
    return errorJson(error);
  }
}
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ error: "id is required", code: "INVALID_REQUEST" }, 400);
  try {
    const removed = await deleteGradeScenario(await ensureUserForClerk(session.userId), id);
    return removed ? json({ deleted: true }) : json({ error: "Scenario not found", code: "SCENARIO_NOT_FOUND" }, 404);
  } catch (error) { return errorJson(error); }
}
