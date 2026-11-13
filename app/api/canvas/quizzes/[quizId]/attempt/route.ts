import { body, json } from "@/lib/bridge/http";
import { getCurrentAttempt, navigateAttempt, QuizServiceError, saveAnswer, startAttempt } from "@/lib/quizzes/service";
import { quizAuth, quizError, requireIdempotencyKey } from "@/lib/quizzes/http";

export const instant = false;

export async function GET(_request: Request, context: { params: Promise<{ quizId: string }> }) {
  try { const ctx = await quizAuth(); const { quizId } = await context.params; return json(await getCurrentAttempt(ctx, quizId)); }
  catch (error) { return quizError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ quizId: string }> }) {
  try {
    requireIdempotencyKey(request); const input = await body(request); const ctx = await quizAuth(); const { quizId } = await context.params;
    return json(await startAttempt(ctx, quizId, input.confirmStart === true));
  } catch (error) { return quizError(error); }
}
export async function PATCH(request: Request, context: { params: Promise<{ quizId: string }> }) {
  try {
    requireIdempotencyKey(request); const input = await body(request); const ctx = await quizAuth(); const { quizId } = await context.params;
    if (typeof input.questionId !== "string" || !/^\d+$/.test(input.questionId)) throw new QuizServiceError("INVALID_QUESTION_ID", "Invalid question id.", 400);
    // One-question-at-a-time quizzes: Canvas-side Next/Previous (record_answer). No answer is changed.
    if (input.navigate !== undefined) {
      if (typeof input.navigate !== "string" || !/^(next|previous|\d{1,20})$/.test(input.navigate)) throw new QuizServiceError("INVALID_NAVIGATION", "Invalid navigation target.", 400);
      return json(await navigateAttempt(ctx, quizId, input.questionId, input.navigate));
    }
    if (!Number.isInteger(input.revision) || Number(input.revision) < 0) throw new QuizServiceError("INVALID_REVISION", "Invalid answer revision.", 400);
    if (input.flagged !== undefined && typeof input.flagged !== "boolean") throw new QuizServiceError("INVALID_FLAG", "Invalid flag state.", 400);
    if (input.answer === undefined && input.flagged === undefined) throw new QuizServiceError("EMPTY_SAVE", "An answer or flag state is required.", 400);
    return json(await saveAnswer(ctx, quizId, input.questionId, input.answer, input.flagged as boolean | undefined, Number(input.revision)));
  } catch (error) { return quizError(error); }
}
