import { fail, reply, requireWebUser } from "@/lib/extension/http";
import { listActionsForOwner } from "@/lib/mcp/actions";

export const instant = false;

/** Approvals: actions proposed by the user's connected assistants (awaiting or history). Clerk + CSRF only. */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "awaiting";
  if (view !== "awaiting" && view !== "history") return fail(400, "BAD_VIEW", "view must be awaiting or history.");
  const max = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(max) || max < 1 || max > 100) return fail(400, "BAD_LIMIT", "limit must be 1-100.");
  return reply(await listActionsForOwner(ctx, view, max));
}
