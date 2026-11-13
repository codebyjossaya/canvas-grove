import { fail, reply, requireWebUser } from "@/lib/extension/http";
import { revokeGrant } from "@/lib/mcp/store";

export const instant = false;

/** Disconnect an OAuth app: revokes the grant and every access/refresh token issued under it. */
export async function DELETE(request: Request, context: { params: Promise<{ grantId: string }> }) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { grantId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(grantId)) return fail(400, "BAD_ID", "Invalid connection id");
  return (await revokeGrant(ctx.ownerId, grantId)) ? reply({ ok: true }) : fail(404, "NOT_FOUND", "That app is not connected.");
}
