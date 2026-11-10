import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { errorJson, json } from "@/lib/bridge/http";
import { listGrades } from "@/lib/grades/service";

export async function GET(request: Request) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try {
    const courseId = new URL(request.url).searchParams.get("courseId");
    return json(await listGrades(await ensureUserForClerk(session.userId), courseId));
  }
  catch (error) { return errorJson(error); }
}
