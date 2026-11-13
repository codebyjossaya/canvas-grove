import { fail, requireWebUser } from "@/lib/extension/http";
import { approveAction } from "@/lib/mcp/actions";
import { executorFor } from "@/lib/mcp/executors";
import { UUID, decisionResponse } from "../../decision";

export const instant = false;

/** Approve and execute now (exactly once). 409 if no longer awaiting, 410 if expired. Never accepts a bearer token. */
export async function POST(request: Request, context: { params: Promise<{ actionId: string }> }) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { actionId } = await context.params;
  if (!UUID.test(actionId)) return fail(400, "BAD_ID", "Invalid action id");
  return decisionResponse(await approveAction(ctx, actionId, executorFor));
}
