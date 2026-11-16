// Pure sign-in detection helpers (no chrome.* calls) so they can be unit tested under node.
// They decide when a request in the sign-in tab is worth an identity probe. They never decide
// that the user is signed in: only Canvas's /api/v1/users/self answer does that.

/** Cookie names Canvas sets once a login completes. Only names are inspected, never values. */
export const SIGNIN_COOKIE_NAMES = ["canvas_session", "_normandy_session", "_legacy_normandy_session", "log_session_id"];

const AUTH_PATH = /^\/(login|saml|logout)/i;

/** True for Canvas's own login, SAML and logout pages (where a 200 means "not signed in yet"). */
export const isAuthPath = (pathname) => AUTH_PATH.test(String(pathname ?? ""));

function setsSessionCookie(headers) {
  if (!Array.isArray(headers)) return false;
  for (const header of headers) {
    if (String(header?.name ?? "").toLowerCase() !== "set-cookie" || typeof header.value !== "string") continue;
    // Chrome may fold several Set-Cookie headers into one value separated by newlines.
    for (const line of header.value.split("\n")) {
      const name = line.split("=", 1)[0].trim();
      if (SIGNIN_COOKIE_NAMES.includes(name)) return true;
    }
  }
  return false;
}

/**
 * A webRequest event -> "set-cookie" | "page" | "api" | null.
 * - a Set-Cookie for a Canvas session cookie on the Canvas origin;
 * - a 200 top-level page on the Canvas origin outside /login*, /saml*, /logout*;
 * - a 200 call to the Canvas API (/api/v1/*), which the dashboard makes once signed in.
 */
export function signInSignal(details, canvasOrigin) {
  let url;
  try { url = new URL(details?.url); } catch { return null; }
  if (url.origin !== canvasOrigin) return null;
  if (setsSessionCookie(details.responseHeaders)) return "set-cookie";
  if (details.statusCode !== 200) return null;
  if (details.type === "main_frame" && !isAuthPath(url.pathname)) return "page";
  if (url.pathname.startsWith("/api/v1/")) return "api";
  return null;
}
