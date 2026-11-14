import { normalizeBridgeError } from "@/lib/bridge/errors";
import { errorJson, json } from "@/lib/bridge/http";
import { activateCapturedCanvasSession } from "@/lib/extension/canvas-auth";
import { MAX_CAPTURE_BODY_BYTES } from "@/lib/extension/canvas-auth-contract";
import { requireDevice } from "@/lib/extension/http";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "@/lib/rate-limit";

export const instant = false;

export async function POST(request: Request) {
  const device = await requireDevice(request);
  if (device instanceof Response) return device;
  const limited = checkRateLimit(RATE_LIMITS.extensionAuth, `${device.ctx.ownerId}:${device.deviceId}`);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSeconds);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_CAPTURE_BODY_BYTES) return errorJson(new Error("Canvas cookie capture is too large"), 413);
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_CAPTURE_BODY_BYTES) return errorJson(new Error("Canvas cookie capture is too large"), 413);
    const input = JSON.parse(raw) as { sessionId?: unknown; canvasOrigin?: unknown; cookies?: unknown };
    return json(await activateCapturedCanvasSession(device, input));
  } catch (error) {
    return errorJson(normalizeBridgeError(error));
  }
}
