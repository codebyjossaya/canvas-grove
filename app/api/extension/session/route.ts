import { authenticateDevice } from "@/lib/bridge/device-auth";
import { errorJson, json } from "@/lib/bridge/http";
import { bridgeStore } from "@/lib/bridge/store";

export async function POST(request: Request) {
  const device = await authenticateDevice(request);
  if (!device) return errorJson(new Error("Invalid device credentials"), 401);
  await bridgeStore.touchDevice(device.id, Date.now());
  return json({ deviceId: device.id, canvasOrigin: device.canvasOrigin, authenticated: true });
}
