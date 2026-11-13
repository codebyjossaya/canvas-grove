import "server-only";
import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk, type AuthContext } from "@/lib/db/auth-context";
import { canvasApiForSession, hostedSessionStore } from "@/lib/bridge/hosted-browser";
import { activeCanvasSession, ProxyError } from "@/lib/canvas/file-proxy";
import { authenticateExtension, type DeviceAuth } from "./devices";

export const NO_STORE = { "cache-control": "no-store", vary: "authorization, cookie" } as const;
export const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
export const fail = (status: number, code: string, error: string) => reply({ error, code }, status);

/** Grove's own pages calling these routes: signed-in Clerk user, same origin, custom header. */
export async function requireWebUser(request: Request): Promise<AuthContext | Response> {
  const site = request.headers.get("sec-fetch-site");
  if (request.headers.get("x-grove-csrf") !== "1" || (site && site !== "same-origin")) return fail(403, "NOT_ALLOWED", "Not allowed");
  const session = await auth();
  if (!session.userId) return fail(401, "AUTH_REQUIRED", "Authentication required");
  return ensureUserForClerk(session.userId);
}

/** The extension calling with its device token. */
export async function requireDevice(request: Request): Promise<DeviceAuth | Response> {
  return (await authenticateExtension(request)) ?? fail(401, "DEVICE_INVALID", "This browser is no longer connected to Canvas Grove.");
}

/** The owner's Canvas origin, even when the sign-in has lapsed (so the extension can still say where it points). */
export async function ownerCanvasOrigin(ctx: AuthContext): Promise<string | null> {
  const sessions = await hostedSessionStore.listForOwner(ctx.clerkUserId);
  const best = sessions.find((s) => s.state === "active") ?? sessions[0];
  return best ? new URL(best.canvasOrigin).origin : null;
}

export async function ownerCanvasCookies(ctx: AuthContext) {
  const hosted = await activeCanvasSession(ctx);
  const cookies = await canvasApiForSession(hosted, ctx.clerkUserId).exportBrowserCookies();
  if (!cookies.length) throw new ProxyError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas in Grove.", 401);
  return { canvasOrigin: new URL(hosted.canvasOrigin).origin, cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite: c.sameSite ?? "Lax" })) };
}
