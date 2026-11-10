import "server-only";
import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { json } from "@/lib/bridge/http";
import { idempotencyKeyFrom, QuizInputError } from "./contracts";
import { QuizServiceError } from "./service";

export async function quizAuth() {
  const session = await auth();
  if (!session.userId) throw new QuizServiceError("AUTH_REQUIRED", "Authentication required.", 401);
  return ensureUserForClerk(session.userId);
}
export function quizError(error: unknown) {
  // Next uses this sentinel while classifying request-bound handlers. It must
  // escape route error mapping or a harmless build probe looks like a 500.
  if (error instanceof Error && error.message.includes("During prerendering")) throw error;
  if (error instanceof QuizServiceError || error instanceof QuizInputError) return json({ error: error.message, code: error.code }, error.status);
  console.error("quiz_mode_failed", { error: error instanceof Error ? error.message : "unknown" });
  return json({ error: "Quiz Mode could not complete this request. Canvas was not submitted automatically.", code: "QUIZ_MODE_FAILED" }, 500);
}
export function requireIdempotencyKey(request: Request) {
  return idempotencyKeyFrom(request);
}
