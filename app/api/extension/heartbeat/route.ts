import { authenticateDevice } from "@/lib/bridge/device-auth";
import { errorJson, json } from "@/lib/bridge/http";
import { bridgeStore } from "@/lib/bridge/store";

export async function POST(request: Request) {
  const device = await authenticateDevice(request);
  if (!device) return errorJson(new Error("Invalid device credentials"), 401);
  const now = Date.now();
  await bridgeStore.touchDevice(device.id, now);
  return json({ ok: true, serverTime: new Date(now).toISOString() });
}
