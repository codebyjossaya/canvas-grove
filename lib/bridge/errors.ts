export type BridgeErrorCode = "BROWSER_HOST_OFFLINE" | "BROWSER_HOST_CAPACITY" | "BROWSER_HOST_AUTH" |
  "BROWSER_SESSION_NOT_FOUND" | "BROWSER_AUTH_EXPIRED" | "BROWSER_NAVIGATION_BLOCKED" |
  "BROWSER_STARTING" | "BROWSER_UNRESPONSIVE" | "BROWSER_HOST_ERROR" | "INTERACTIVE_AUTH_TIMEOUT" |
  "INVALID_SESSION_STATE" | "REQUEST_FAILED" |
  // Direct, cookie-authenticated Canvas API (lib/canvas/session-client.ts).
  "CANVAS_SESSION_EXPIRED" | "CANVAS_UNREACHABLE" | "CANVAS_RESPONSE_TOO_LARGE" | "CANVAS_PATH_NOT_ALLOWED" | "CANVAS_ORIGIN_INVALID";
  

export class BridgeError extends Error {
  constructor(public readonly code: BridgeErrorCode, message: string, public readonly status = 503, public readonly blockedHost?: string) {
    super(message); this.name = "BridgeError";
  }
}

export function normalizeBridgeError(error: unknown) {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : "";
  const lower = message.toLowerCase();
  if (/(still starting|not ready|warming)/i.test(message)) return new BridgeError("BROWSER_STARTING", "The secure browser is still starting. Retry shortly.", 425);
  if (/(unresponsive|hung|renderer is unavailable|probe failed)/i.test(message)) return new BridgeError("BROWSER_UNRESPONSIVE", "The secure browser stopped responding and is being repaired. Retry shortly.", 503);
  if (lower.includes("auth") && lower.includes("expired")) return new BridgeError("BROWSER_AUTH_EXPIRED", "Canvas sign-in has expired.", 401);
  if (lower.includes("capacity") || lower.includes("no available")) return new BridgeError("BROWSER_HOST_CAPACITY", "The browser host is at capacity. Try again shortly.", 429);
  if (/(econnrefused|enotfound|fetch failed|network|offline)/i.test(message)) return new BridgeError("BROWSER_HOST_OFFLINE", "The browser host is unavailable. Try again shortly.", 503);
  if (/(playwright|page\.|browserType|cdp|docker|socket|internal|stack)/i.test(message)) return new BridgeError("BROWSER_HOST_ERROR", "The secure browser could not complete the request.", 503);
  return new BridgeError("REQUEST_FAILED", message || "The request could not be completed.", 400);
}

export function bridgeErrorBody(error: BridgeError) {
  const blockedHost = error.code === "BROWSER_NAVIGATION_BLOCKED" && error.blockedHost &&
    /^(?!\d+(?:\.\d+){3}$)(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(error.blockedHost)
    ? error.blockedHost : undefined;
  return { error: error.message, code: error.code, ...(blockedHost ? { blockedHost } : {}) };
}
