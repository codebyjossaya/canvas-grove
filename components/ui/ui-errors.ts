export type UiError = {
  code: string;
  title: string;
  message: string;
  nextAction: string;
  technical?: string;
  blockedHost?: string;
};

const known: Record<string, Omit<UiError, "code" | "technical">> = {
  AUTH_REQUIRED: { title: "Your app session expired", message: "Your cached Canvas data is still safe.", nextAction: "Sign in to Canvas Grove again, then retry." },
  CANVAS_AUTH_EXPIRED: { title: "Canvas needs you to sign in again", message: "Previously synced courses and deadlines are still safe and readable.", nextAction: "Open Settings and reconnect Canvas in the secure live browser." },
  INTERACTIVE_AUTH_TIMEOUT: { title: "Secure sign-in time expired", message: "The expired browser was closed. Previously synced Canvas data is still safe and readable.", nextAction: "Start a new secure sign-in. Reopen and Retry cannot extend the expired attempt." },
  HOST_OFFLINE: { title: "The secure browser host is offline", message: "Your saved data and encrypted session have not been deleted.", nextAction: "Wait until the operator's machine is online, then retry." },
  HOST_CAPACITY: { title: "All secure browser slots are busy", message: "Your existing data and connection settings are safe.", nextAction: "Wait a minute, then retry." },
  NETWORK_OFFLINE: { title: "This device appears to be offline", message: "Previously synced data remains available.", nextAction: "Check your network connection, then retry." },
  LIVE_VIEW_EXISTS: { title: "A secure live view is already open", message: "Your browser session is still safe.", nextAction: "Return to the existing live view, or wait for its temporary link to expire." },
  INVALID_CANVAS_URL: { title: "That Canvas address is not valid", message: "Nothing was saved or changed.", nextAction: "Enter only your school's HTTPS Canvas address, such as https://school.instructure.com." },
  SESSION_NOT_FOUND: { title: "This browser session is no longer available", message: "Previously synced Canvas data is still safe.", nextAction: "Create a new secure browser connection in Settings." },
  VERIFY_PENDING: { title: "Canvas sign-in is not finished yet", message: "Your existing data is safe.", nextAction: "Complete your institution sign-in and any multi-factor prompt in the live browser, then verify again." },
  POPUP_BLOCKED: { title: "Your browser blocked the secure live view", message: "The Canvas container is still running and your data is safe.", nextAction: "Select Open secure live browser, or allow popups for this site and retry." },
  POPUP_CLOSED: { title: "The secure browser window was closed", message: "Your Canvas session is still running and your saved data is safe.", nextAction: "Select Reopen secure browser to finish signing in, or cancel and revoke the session." },
  NAVIGATION_BLOCKED: { title: "Institution sign-in redirect blocked", message: "Canvas Grove stopped an unapproved sign-in destination before showing it to you.", nextAction: "Confirm the blocked hostname belongs to your institution. If it does, retry or reconnect with that exact sign-in domain; otherwise cancel the session." },
  SERVER_UNAVAILABLE: { title: "Canvas Grove could not reach the secure browser", message: "Your saved data has not been changed.", nextAction: "Wait a moment and retry. If this continues, ask the operator to check the browser host." },
  UNKNOWN: { title: "That action could not be completed", message: "Your saved data has not been changed.", nextAction: "Retry once. If it continues, share the technical detail with the operator." },
};

export function toUiError(value: unknown, fallbackCode = "UNKNOWN"): UiError {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const text = decode(raw).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const inferred = lower.includes("authentication required") || lower.includes("unauthorized") ? "AUTH_REQUIRED"
    : lower.includes("auth") && lower.includes("expired") ? "CANVAS_AUTH_EXPIRED"
      : lower.includes("capacity") || lower.includes("no available") ? "HOST_CAPACITY"
        : lower.includes("offline") || lower.includes("econnrefused") || lower.includes("fetch failed") ? "HOST_OFFLINE"
          : lower.includes("live-view url") && lower.includes("valid") ? "LIVE_VIEW_EXISTS"
            : lower.includes("canvasorigin") || lower.includes("invalid url") ? "INVALID_CANVAS_URL"
              : lower.includes("session not found") ? "SESSION_NOT_FOUND"
                : lower.includes("not connected yet") ? "VERIFY_PENDING" : "UNKNOWN";
  const code = fallbackCode !== "UNKNOWN" && known[fallbackCode] ? fallbackCode : inferred;
  const safe = known[code] ?? known.UNKNOWN;
  const technical = text && !looksSensitive(text) ? sanitizeTechnical(text) : undefined;
  const blockedHost = safeBlockedHostname(typeof value === "object" && value !== null && "blockedHost" in value ? (value as { blockedHost?: unknown }).blockedHost : undefined);
  return { code, title: safe.title, message: safe.message, nextAction: safe.nextAction, technical, blockedHost };
}

function decode(value: string) {
  return value.replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function looksSensitive(value: string) {
  return /cookie|token|password|authorization|secret|stack|samlrequest|samlresponse|relaystate|at \w+ \(/i.test(value);
}

function sanitizeTechnical(value: string) {
  return value.replace(/page\.goto[^:]*:?/gi, "Browser navigation failed: ").replace(/https?:\/\/[^\s)]+/g, "[address removed]").slice(0, 240);
}

export function safeBlockedHostname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || /[\/:?#@\s]/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) return undefined;
  if (["localhost", "localhost.localdomain", "0.0.0.0"].includes(host) || [".local", ".localhost", ".internal", ".home", ".lan"].some((suffix) => host.endsWith(suffix))) return undefined;
  return host.split(".").length > 1 && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : undefined;
}
