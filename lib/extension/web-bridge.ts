/**
 * Page side of the Grove extension protocol v2 (docs/plans/orientation-v2.md, Contract 1).
 *
 * Transport: window.postMessage between a Grove page and the extension's content script in the same
 * window. Requests are `{source:"grove-web", type, requestId, ...payload}`; replies are
 * `{source:"grove-extension", type:"reply", requestId, result}`. The extension also posts unsolicited
 * `{type:"state"}` and `{type:"signin"}` events. Every listener here accepts only messages from this
 * window and this origin, so another frame or site cannot impersonate the extension.
 *
 * Client-only. `window` is read at call time so tests can install a stub on globalThis.
 */
import { BRIDGE } from "./links";

export type SigninStage = "opening" | "needs-access" | "signing-in" | "verifying" | "captured" | "failed" | "cancelled" | "tab-closed";
export type SigninStatus = {
  sessionId: string;
  stage: SigninStage;
  canvasOrigin: string;
  account?: { id: string; name: string };
  reason?: string;
  at: number;
};
export type ExtState = {
  installed: true;
  protocol: 2;
  version: string;
  paired: boolean;
  deviceName: string | null;
  canvasOrigin: string | null;
  hasCanvasAccess: boolean;
  signin: SigninStatus | null;
};
/** What an extension older than protocol 2 (< 0.4.0) tells us: it answers only `canvas-auth-state`. */
export type LegacyExtState = { installed: true; protocol: 1; version: null; paired: boolean };
export type ExtensionEvent = { type: "state"; state: ExtState } | { type: "signin"; status: SigninStatus };
export type ExtRequestType = "hello" | "pair" | "signin-start" | "signin-status" | "signin-focus" | "signin-cancel" | "open";

/** Thrown when the extension does not answer in time (not installed, disabled, or too old for this request). */
export class ExtensionTimeoutError extends Error {
  readonly code = "EXTENSION_TIMEOUT";
  constructor(readonly requestType: string) { super(`The Grove extension did not answer "${requestType}".`); }
}

type BridgeWindow = Pick<Window, "addEventListener" | "removeEventListener" | "postMessage" | "setTimeout" | "clearTimeout"> & { location: { origin: string } };
type Envelope = { source?: unknown; type?: unknown; requestId?: unknown; result?: unknown; state?: unknown; status?: unknown };

function win(): BridgeWindow | null {
  const value = (globalThis as { window?: BridgeWindow }).window;
  return value && typeof value.postMessage === "function" ? value : null;
}

function newRequestId() {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The message came from the extension's content script in this exact window and origin. */
function fromExtension(event: MessageEvent, w: BridgeWindow): Envelope | null {
  if (event.source !== (w as unknown) || event.origin !== w.location.origin) return null;
  const data = event.data as Envelope | null;
  if (!data || typeof data !== "object" || data.source !== BRIDGE.extension) return null;
  return data;
}

const STAGES: ReadonlySet<string> = new Set<SigninStage>(["opening", "needs-access", "signing-in", "verifying", "captured", "failed", "cancelled", "tab-closed"]);

export function isSigninStatus(value: unknown): value is SigninStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === "string" && typeof v.stage === "string" && STAGES.has(v.stage) && typeof v.canvasOrigin === "string";
}

export function isExtState(value: unknown): value is ExtState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.installed === true && typeof v.protocol === "number" && v.protocol >= 2 && typeof v.paired === "boolean";
}

function normalizeState(value: ExtState): ExtState {
  return {
    installed: true,
    protocol: 2,
    version: typeof value.version === "string" ? value.version : "",
    paired: value.paired === true,
    deviceName: typeof value.deviceName === "string" ? value.deviceName : null,
    canvasOrigin: typeof value.canvasOrigin === "string" ? value.canvasOrigin : null,
    hasCanvasAccess: value.hasCanvasAccess === true,
    signin: isSigninStatus(value.signin) ? value.signin : null,
  };
}

/**
 * Send one request and resolve with the extension's `result`. Rejects with ExtensionTimeoutError when
 * no reply arrives in `timeoutMs`. The payload is flattened next to `type` and `requestId`, matching
 * the v1 bridge convention. Never log the payload: `pair` carries the device token.
 */
export function extRequest<T = unknown>(type: ExtRequestType, payload: Record<string, unknown> = {}, timeoutMs = 4000): Promise<T> {
  const w = win();
  if (!w) return Promise.reject(new ExtensionTimeoutError(type));
  return new Promise<T>((resolve, reject) => {
    const requestId = newRequestId();
    const onMessage = (event: MessageEvent) => {
      const data = fromExtension(event, w);
      if (!data || data.type !== "reply" || data.requestId !== requestId) return;
      cleanup();
      resolve(data.result as T);
    };
    const timer = w.setTimeout(() => { cleanup(); reject(new ExtensionTimeoutError(type)); }, timeoutMs);
    const cleanup = () => { w.clearTimeout(timer); w.removeEventListener("message", onMessage as EventListener); };
    w.addEventListener("message", onMessage as EventListener);
    w.postMessage({ ...payload, source: BRIDGE.web, type, requestId }, w.location.origin);
  });
}

/** How long to keep waiting for a v2 `hello` reply after a legacy (v1) extension has answered. */
const LEGACY_GRACE_MS = 400;

/**
 * Ask the extension who it is. Resolves with:
 * - `ExtState` from a protocol-2 extension,
 * - `LegacyExtState` when only the v1 `canvas-auth-state` probe was answered (extension < 0.4.0),
 * - `null` when nothing answered (not installed, disabled, or content script not injected yet).
 */
export function extHello(timeoutMs = 1200): Promise<ExtState | LegacyExtState | null> {
  const w = win();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const helloId = newRequestId();
    const legacyId = newRequestId();
    let legacy: LegacyExtState | null = null;
    let graceTimer: number | undefined;
    const finish = (value: ExtState | LegacyExtState | null) => {
      w.clearTimeout(timer);
      if (graceTimer !== undefined) w.clearTimeout(graceTimer);
      w.removeEventListener("message", onMessage as EventListener);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const data = fromExtension(event, w);
      if (!data) return;
      if (data.type === "reply" && data.requestId === helloId) {
        finish(isExtState(data.result) ? normalizeState(data.result) : legacy);
        return;
      }
      // A protocol-2 extension may announce itself before replying; treat it as the answer.
      if (data.type === "state" && isExtState(data.state)) { finish(normalizeState(data.state)); return; }
      // v1 extensions reply to canvas-auth-* with `canvas-auth-result` and ignore `hello`.
      if (data.type === "canvas-auth-result" && data.requestId === legacyId && !legacy) {
        const result = (data.result ?? {}) as { installed?: unknown; paired?: unknown };
        legacy = { installed: true, protocol: 1, version: null, paired: result.paired === true };
        graceTimer = w.setTimeout(() => finish(legacy), LEGACY_GRACE_MS);
      }
    };
    const timer = w.setTimeout(() => finish(legacy), timeoutMs);
    w.addEventListener("message", onMessage as EventListener);
    w.postMessage({ source: BRIDGE.web, type: "hello", requestId: helloId }, w.location.origin);
    w.postMessage({ source: BRIDGE.web, type: "canvas-auth-state", requestId: legacyId }, w.location.origin);
  });
}

/** Listen for unsolicited `state` and `signin` events. Returns an unsubscribe function. */
export function subscribeExtension(listener: (event: ExtensionEvent) => void): () => void {
  const w = win();
  if (!w) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = fromExtension(event, w);
    if (!data) return;
    if (data.type === "state" && isExtState(data.state)) listener({ type: "state", state: normalizeState(data.state) });
    else if (data.type === "signin" && isSigninStatus(data.status)) listener({ type: "signin", status: data.status });
  };
  w.addEventListener("message", onMessage as EventListener);
  return () => w.removeEventListener("message", onMessage as EventListener);
}

/** Compare dotted versions numerically ("0.10.0" > "0.4.0"). Missing parts count as 0. */
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

const CAPTURE_REJECTED: Record<string, string> = {
  CANVAS_SESSION_EXPIRED: "This sign-in attempt expired before Canvas finished. Start a new sign-in.",
  CANVAS_SESSION_CHANGED: "This sign-in attempt was replaced by a newer one. Start a new sign-in.",
  CANVAS_SESSION_NOT_FOUND: "Grove no longer has this sign-in attempt. Start a new sign-in.",
  CANVAS_SESSION_INVALID: "This sign-in attempt is no longer valid. Start a new sign-in.",
  CANVAS_COOKIE_CAPTURE_SCOPE: "The tab signed in to a different Canvas site than the one you chose. Start again and stay on the same site.",
  CANVAS_COOKIE_CAPTURE_INVALID: "The extension sent a Canvas session Grove could not read. Start a new sign-in.",
  CANVAS_COOKIE_CAPTURE_EXPIRED: "Canvas ended the session before Grove could save it. Sign in again.",
  CANVAS_SESSION_COOKIE_MISSING: "Canvas did not create a session in this browser. Finish signing in, then try again.",
  CANVAS_AUTH_NOT_VERIFIED: "Canvas did not accept the session when Grove checked it. Sign in again.",
  DEVICE_REVOKED: "This browser was disconnected from Grove. Connect it again from the extension page.",
};

/** Plain-language copy for a stable extension `reason` code. Unknown codes get a safe generic line. */
export function reasonMessage(reason: string | null | undefined): string {
  const code = (reason ?? "").trim();
  if (code.startsWith("capture-rejected")) {
    const server = code.slice("capture-rejected".length).replace(/^:/, "");
    return CAPTURE_REJECTED[server] ?? "Grove could not verify the Canvas session from this browser. Start a new sign-in.";
  }
  switch (code) {
    case "permission-denied": return "Access to your Canvas site was not allowed. Choose Allow when the browser asks, so the extension can read that one site's sign-in.";
    case "expired": return "This sign-in attempt timed out after 30 minutes. Start a new sign-in.";
    case "revoked": return "This browser was disconnected from Grove. Connect it again, then sign in.";
    case "not-paired": case "not-connected": return "The Grove extension is not connected to your account yet. Connect this browser first.";
    case "session-cookie-missing": return "Canvas did not create a session in this browser. Finish signing in, then try again.";
    case "tab-closed": return "The sign-in tab was closed before Canvas finished. Reopen it to continue.";
    case "cancelled": return "Sign-in was cancelled.";
    case "tab-failed": case "popup-failed": return "The browser could not open the sign-in tab. Try again.";
    case "origin-mismatch": return "The sign-in tab ended up on a different Canvas site. Start again and stay on your school's Canvas.";
    case "network": case "offline": return "The extension could not reach Grove. Check your connection, then try again.";
    case "busy": return "Another sign-in is already running in this browser. Finish or cancel it first.";
    case "unavailable": return "The Grove extension did not respond. Reload this page, then try again.";
    default: return "The Grove extension could not finish Canvas sign-in. Try again.";
  }
}
