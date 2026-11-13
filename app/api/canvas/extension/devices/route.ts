import { DeviceLimitError, createDevice, listDevices } from "@/lib/extension/devices";
import { cleanDeviceName } from "@/lib/extension/device-token";
import { fail, ownerCanvasOrigin, reply, requireWebUser } from "@/lib/extension/http";

export const instant = false;

/** Connected browsers for the signed-in user (Settings). */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  return reply({ devices: await listDevices(ctx) });
}

/**
 * Pair a browser. Called by Grove's own /extension/connect page after the user confirms; the
 * returned token goes straight to the extension (page -> content script) and is never shown.
 */
export async function POST(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const body = await request.json().catch(() => ({})) as { name?: unknown };
  try {
    const { device, token } = await createDevice(ctx, cleanDeviceName(body.name), request.headers.get("user-agent"));
    return reply({ device, token, canvasOrigin: await ownerCanvasOrigin(ctx) }, 201);
  } catch (error) {
    if (error instanceof DeviceLimitError) return fail(409, "DEVICE_LIMIT", error.message);
    return fail(500, "PAIR_FAILED", "Could not connect this browser.");
  }
}
