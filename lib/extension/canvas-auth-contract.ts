import { BridgeError } from "@/lib/bridge/errors";
import { SESSION_COOKIE_NAMES, type StoredCookie } from "@/lib/canvas/session-client";

export const MAX_CAPTURE_BODY_BYTES = 128 * 1024;
export const MAX_CAPTURED_COOKIES = 64;
const MAX_COOKIE_VALUE = 16_384;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

type CapturedCookie = Partial<StoredCookie> & { name?: unknown; value?: unknown; domain?: unknown; path?: unknown };

export function canvasUserIdFromVerification(verified: { ok: boolean; authRequired: boolean; data?: unknown }): string {
  const data = verified.data && typeof verified.data === "object" ? verified.data as { id?: unknown } : {};
  const canvasUserId = typeof data.id === "number" || typeof data.id === "string" ? String(data.id) : "";
  if (!verified.ok || verified.authRequired || !/^[0-9]{1,30}$/.test(canvasUserId)) {
    throw new BridgeError("CANVAS_AUTH_NOT_VERIFIED", "Canvas did not accept this browser's sign-in.", 401);
  }
  return canvasUserId;
}

export function normalizeCapturedCookies(value: unknown, canvasOrigin: string, now = Date.now() / 1000): StoredCookie[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPTURED_COOKIES) {
    throw new BridgeError("CANVAS_COOKIE_CAPTURE_INVALID", "The Canvas cookie capture is invalid.", 400);
  }
  const host = new URL(canvasOrigin).hostname.toLowerCase();
  let total = 0;
  const cookies = value.map((item) => {
    const cookie = item as CapturedCookie;
    const name = typeof cookie.name === "string" ? cookie.name : "";
    const rawValue = typeof cookie.value === "string" ? cookie.value : "";
    const domain = typeof cookie.domain === "string" ? cookie.domain.toLowerCase() : "";
    const path = typeof cookie.path === "string" ? cookie.path : "/";
    const expires = typeof cookie.expires === "number" && Number.isFinite(cookie.expires) ? cookie.expires : -1;
    if (!COOKIE_NAME.test(name) || rawValue.length > MAX_COOKIE_VALUE || /[\u0000-\u001f\u007f;]/.test(rawValue)) {
      throw new BridgeError("CANVAS_COOKIE_CAPTURE_INVALID", "The Canvas cookie capture contains an invalid cookie.", 400);
    }
    if (domain !== host || !path.startsWith("/") || path.length > 2048 || /[\u0000-\u001f\u007f;]/.test(path)) {
      throw new BridgeError("CANVAS_COOKIE_CAPTURE_SCOPE", "The cookie capture was not limited to the Canvas site.", 400);
    }
    if (expires > 0 && expires <= now) throw new BridgeError("CANVAS_COOKIE_CAPTURE_EXPIRED", "The Canvas cookie capture has expired.", 401);
    const sameSite: StoredCookie["sameSite"] = cookie.sameSite === "Strict" || cookie.sameSite === "None" ? cookie.sameSite : "Lax";
    total += name.length + rawValue.length + domain.length + path.length;
    return { name, value: rawValue, domain: host, path, expires, httpOnly: cookie.httpOnly === true, secure: true, sameSite };
  });
  if (total > 64 * 1024 || !cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name))) {
    throw new BridgeError("CANVAS_SESSION_COOKIE_MISSING", "No live Canvas session was found in this browser.", 401);
  }
  return cookies;
}
