import { activeCanvasSession } from "@/lib/canvas/file-proxy";
import { ownerCanvasOrigin, reply, requireDevice } from "@/lib/extension/http";

export const instant = false;

/** What the extension popup shows: is this browser still paired, and is Grove signed in to Canvas. */
export async function GET(request: Request) {
  const device = await requireDevice(request);
  if (device instanceof Response) return device;
  const canvasConnected = await activeCanvasSession(device.ctx).then(() => true, () => false);
  return reply({ deviceName: device.deviceName, canvasOrigin: await ownerCanvasOrigin(device.ctx), canvasConnected });
}
