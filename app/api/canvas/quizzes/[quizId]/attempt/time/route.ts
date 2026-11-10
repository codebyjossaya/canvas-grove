import { json } from "@/lib/bridge/http";
import { getAttemptTime } from "@/lib/quizzes/service";
import { quizAuth, quizError } from "@/lib/quizzes/http";

export const instant = false;

export async function GET(_request: Request, context: { params: Promise<{ quizId: string }> }) {
  try { const ctx = await quizAuth(); const { quizId } = await context.params; const value = await getAttemptTime(ctx, quizId); return json({ timing: value.timing, attempt: value.attempt }); }
  catch (error) { return quizError(error); }
}
