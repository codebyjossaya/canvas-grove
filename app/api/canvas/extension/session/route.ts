import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { canvasApiForSession } from "@/lib/bridge/hosted-browser";
import { activeCanvasSession, ProxyError } from "@/lib/canvas/file-proxy";

export const instant = false;

const NO_STORE = { "cache-control": "no-store", vary: "cookie" };

/**
 * Hands the signed-in owner's Canvas cookies to the Grove browser extension running on a page of
 * this same origin, so the owner's own browser can open Canvas already signed in (LTI tools and
 * New Quizzes cannot be launched through Grove). POST + same-origin + a custom header: a
 * cross-site page can neither read this response nor trigger it.
 */
export async function POST(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.headers.get("x-grove-extension") !== "1" || (fetchSite && fetchSite !== "same-origin")) {
    return Response.json({ error: "Not allowed", code: "EXTENSION_ONLY" }, { status: 403, headers: NO_STORE });
  }
  const session = await auth();
  if (!session.userId) return Response.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: NO_STORE });
  try {
    const ctx = await ensureUserForClerk(session.userId);
    const hosted = await activeCanvasSession(ctx);
    const client = canvasApiForSession(hosted, ctx.clerkUserId);
    const cookies = await client.exportBrowserCookies();
    if (!cookies.length) throw new ProxyError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas.", 401);
    return Response.json({
      canvasOrigin: new URL(hosted.canvasOrigin).origin,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite: c.sameSite ?? "Lax" })),
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ProxyError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
    return Response.json({ error: "Could not read the Canvas session", code: "SESSION_UNAVAILABLE" }, { status: 502, headers: NO_STORE });
  }
}
