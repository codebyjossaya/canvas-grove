import { body, json } from "@/lib/bridge/http";
import { QuizServiceError, submitAttempt } from "@/lib/quizzes/service";
import { quizAuth, quizError, requireIdempotencyKey } from "@/lib/quizzes/http";

export const instant = false;

export async function POST(request: Request, context: { params: Promise<{ quizId: string }> }) {
  try {
    requireIdempotencyKey(request); const input = await body(request); const ctx = await quizAuth(); const { quizId } = await context.params;
    if (!Number.isInteger(input.expectedAttempt) || Number(input.expectedAttempt) < 1) throw new QuizServiceError("INVALID_ATTEMPT", "Invalid attempt number.", 400);
    if (!Number.isInteger(input.pendingSaves) || Number(input.pendingSaves) < 0) throw new QuizServiceError("INVALID_PENDING_SAVES", "Invalid pending save count.", 400);
    const result = await submitAttempt(ctx, quizId, input.confirmSubmit === true, Number(input.expectedAttempt), Number(input.pendingSaves));
    return json({ ...result, attempt: result.receipt.attempt, submittedAt: result.receipt.finishedAt ?? new Date().toISOString(), confirmationId: result.receipt.id });
  } catch (error) { return quizError(error); }
}
