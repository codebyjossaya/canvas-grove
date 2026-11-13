import { ProxyError } from "@/lib/canvas/file-proxy";
import { fail, ownerCanvasCookies, reply, requireDevice } from "@/lib/extension/http";

export const instant = false;

/** The extension asks for the Canvas cookies Grove holds, to install them in its own browser. */
export async function POST(request: Request) {
  const device = await requireDevice(request);
  if (device instanceof Response) return device;
  try { return reply(await ownerCanvasCookies(device.ctx)); }
  catch (error) {
    if (error instanceof ProxyError) return fail(error.status, error.code, error.message);
    console.error("extension canvas-session failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    return fail(502, "SESSION_UNAVAILABLE", "Could not read the Canvas session.");
  }
}
