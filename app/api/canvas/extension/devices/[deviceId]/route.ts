import { revokeDevice } from "@/lib/extension/devices";
import { fail, reply, requireWebUser } from "@/lib/extension/http";

export const instant = false;

/** Disconnect a browser from Settings. Its token stops working immediately. */
export async function DELETE(request: Request, context: { params: Promise<{ deviceId: string }> }) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { deviceId } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(deviceId)) return fail(400, "BAD_ID", "Invalid device");
  return (await revokeDevice(ctx.ownerId, deviceId)) ? reply({ ok: true }) : fail(404, "NOT_FOUND", "That browser is not connected.");
}
