// Pure helpers (no chrome.* calls) so they can be unit tested under node.
export const SESSION_COOKIE_NAMES = ["canvas_session", "_normandy_session", "_legacy_normandy_session"];

/** An origin the user typed -> "https://host" (or http://localhost for development), else null. */
export function normalizeOrigin(value) {
  try {
    const url = new URL(String(value).trim());
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !local) return null;
    return url.origin;
  } catch { return null; }
}

/** True if `url` is on exactly `origin` (the only place a Canvas link may point). */
export function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

/**
 * Server cookie -> chrome.cookies.set details, or null if it must not be installed.
 * Always host-only on the Canvas host: a Domain=.instructure.com cookie would also be sent to
 * other schools' Canvas tenants, and the server only needs it on this host. Cookies naming a
 * different host are refused.
 */
export function toChromeCookie(cookie, canvasOrigin, nowSeconds = Date.now() / 1000) {
  if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string" || !cookie.name) return null;
  const origin = new URL(canvasOrigin);
  const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  if (!domain || (domain !== origin.hostname && !origin.hostname.endsWith(`.${domain}`))) return null;
  const expires = typeof cookie.expires === "number" ? cookie.expires : -1;
  if (expires > 0 && expires <= nowSeconds) return null;
  const sameSite = { Strict: "strict", Lax: "lax", None: "no_restriction" }[cookie.sameSite] ?? "lax";
  const secure = origin.protocol === "https:" ? cookie.secure !== false || sameSite === "no_restriction" : false;
  const path = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  const details = { url: `${origin.origin}${path}`, name: cookie.name, value: cookie.value, path, secure, httpOnly: !!cookie.httpOnly, sameSite };
  if (expires > 0) details.expirationDate = expires;
  return details;
}

export function hasLiveSession(cookies, nowSeconds = Date.now() / 1000) {
  return cookies.some((c) => SESSION_COOKIE_NAMES.includes(c.name) && (c.session || !c.expirationDate || c.expirationDate > nowSeconds));
}
