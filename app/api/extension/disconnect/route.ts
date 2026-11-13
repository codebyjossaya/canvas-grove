import { revokeDevice } from "@/lib/extension/devices";
import { reply, requireDevice } from "@/lib/extension/http";

export const instant = false;

/** The extension disconnecting itself (popup "Disconnect"). */
export async function POST(request: Request) {
  const device = await requireDevice(request);
  if (device instanceof Response) return device;
  await revokeDevice(device.ctx.ownerId, device.deviceId);
  return reply({ ok: true });
}
