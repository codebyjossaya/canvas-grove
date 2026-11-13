import { fail, requireWebUser } from "@/lib/extension/http";
import { rejectAction } from "@/lib/mcp/actions";
import { UUID, decisionResponse } from "../../decision";

export const instant = false;

export async function POST(request: Request, context: { params: Promise<{ actionId: string }> }) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { actionId } = await context.params;
  if (!UUID.test(actionId)) return fail(400, "BAD_ID", "Invalid action id");
  return decisionResponse(await rejectAction(ctx, actionId));
}
