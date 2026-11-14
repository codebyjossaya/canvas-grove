import { json } from "@/lib/bridge/http";
import { requireWebUser } from "@/lib/extension/http";
import { assignmentBody, assignmentSubmissionError } from "@/lib/assignments/http";
import { idempotencyKeyFrom, parseAssignmentSubmission } from "@/lib/assignments/contracts";
import { submitAssignment } from "@/lib/assignments/service";

export const instant = false;

export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  try {
    const ctx = await requireWebUser(request);
    if (ctx instanceof Response) return ctx;
    const key = idempotencyKeyFrom(request);
    const input = parseAssignmentSubmission(await assignmentBody(request));
    const { assignmentId } = await context.params;
    return json(await submitAssignment(ctx, assignmentId, input, key));
  } catch (error) { return assignmentSubmissionError(error); }
}
