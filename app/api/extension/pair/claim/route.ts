import { body, errorJson, json } from "@/lib/bridge/http";
import { digest, newId, newSecret } from "@/lib/bridge/crypto";
import { bridgeStore } from "@/lib/bridge/store";
import { validatePublicCanvasOrigin } from "@/lib/canvas/public-origin";

export async function POST(request: Request) {
  try {
    const input = await body(request);
    const code = String(input.code || "").trim().toUpperCase();
    const name = String(input.deviceName || "Browser extension").trim().slice(0, 80);
    const canvasOrigin = await validatePublicCanvasOrigin(input.canvasOrigin);
    const pairing = await bridgeStore.claimPairing(digest(code), Date.now());
    if (!pairing) return errorJson(new Error("Pairing code is invalid or expired"), 401);
    const deviceSecret = newSecret();
    const device = { id: newId(), userId: pairing.userId, name, canvasOrigin, credentialHash: digest(deviceSecret), createdAt: Date.now() };
    await bridgeStore.createDevice(device);
    return json({ deviceId: device.id, deviceSecret, canvasOrigin: device.canvasOrigin }, 201);
  } catch (error) { return errorJson(error); }
}
