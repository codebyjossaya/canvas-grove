import { fail, reply, requireWebUser } from "@/lib/extension/http";
import { revokePat } from "@/lib/mcp/store";

export const instant = false;

/** Revoke a personal access token. It stops working immediately. */
export async function DELETE(request: Request, context: { params: Promise<{ tokenId: string }> }) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { tokenId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tokenId)) return fail(400, "BAD_ID", "Invalid token id");
  return (await revokePat(ctx.ownerId, tokenId)) ? reply({ ok: true }) : fail(404, "NOT_FOUND", "That token does not exist or was already revoked.");
}
