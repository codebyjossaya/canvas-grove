"use client";

/**
 * Live Grove-extension status for any page (Contract 2). One module-level store is shared by every
 * component that calls `useExtension()`, so the page sends one `hello` at a time no matter how many
 * consumers are mounted.
 */
import { useSyncExternalStore } from "react";
import type { UiError } from "@/components/ui/ui-errors";
import { EXTENSION_MIN_VERSION } from "./links";
import { compareVersions, extHello, extRequest, ExtensionTimeoutError, reasonMessage, subscribeExtension, type ExtState, type LegacyExtState } from "./web-bridge";

export type ExtensionStatus = "checking" | "missing" | "outdated" | "unpaired" | "ready";
export type ExtensionSnapshot = { status: ExtensionStatus; state: ExtState | null };

/** Minimum extension version that speaks protocol 2. Owned by lib/extension/links.ts (Agent A). */
export const MIN_EXTENSION_VERSION: string = EXTENSION_MIN_VERSION;

/** An Error that is also a UiError, so callers can `catch (e) { setError(e) }` or render it directly. */
export class SignInError extends Error implements UiError {
  readonly code: string;
  readonly title: string;
  readonly nextAction: string;
  readonly technical?: string;
  constructor(input: { code: string; title: string; message: string; nextAction?: string; technical?: string }) {
    super(input.message);
    this.name = "SignInError";
    this.code = input.code;
    this.title = input.title;
    this.nextAction = input.nextAction ?? "";
    this.technical = input.technical;
  }
}

/** Plain UiError object (no Error prototype) for React state. */
export function toPlainUiError(error: UiError): UiError {
  return { code: error.code, title: error.title, message: error.message, nextAction: error.nextAction, technical: error.technical, blockedHost: error.blockedHost };
}

export function statusFor(value: ExtState | LegacyExtState | null, minVersion = MIN_EXTENSION_VERSION): ExtensionStatus {
  if (!value) return "missing";
  if (value.protocol < 2 || !value.version || compareVersions(value.version, minVersion) < 0) return "outdated";
  return value.paired ? "ready" : "unpaired";
}

// ------------------------------------------------------------------ shared store

const POLL_MS = 1500;
const CHECKING: ExtensionSnapshot = { status: "checking", state: null };
let snapshot: ExtensionSnapshot = CHECKING;
const listeners = new Set<() => void>();
let stopRuntime: (() => void) | null = null;
let inFlight: Promise<void> | null = null;
let misses = 0;

function emit(next: ExtensionSnapshot) {
  if (next.status === snapshot.status && JSON.stringify(next.state) === JSON.stringify(snapshot.state)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function accept(value: ExtState | LegacyExtState | null) {
  if (value) misses = 0;
  // A sleeping service worker can miss one hello; only fall back to "missing" after two misses in a row.
  else if (snapshot.status !== "checking" && snapshot.status !== "missing" && ++misses < 2) return;
  emit({ status: statusFor(value), state: value && value.protocol === 2 ? value : null });
}

function check(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = extHello().then(accept, () => accept(null)).finally(() => { inFlight = null; });
  return inFlight;
}

function startRuntime() {
  const unsubscribe = subscribeExtension((event) => {
    if (event.type === "state") accept(event.state);
    else if (snapshot.state) emit({ status: snapshot.status, state: { ...snapshot.state, signin: event.status } });
  });
  const onVisible = () => { if (document.visibilityState === "visible") void check(); };
  // Keep asking until the extension is ready: detection then flips within ~1.5 s of "Load unpacked".
  const timer = window.setInterval(() => { if (snapshot.status !== "ready" && document.visibilityState === "visible") void check(); }, POLL_MS);
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  void check();
  return () => {
    unsubscribe();
    window.clearInterval(timer);
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stopRuntime) stopRuntime = startRuntime();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stopRuntime) { stopRuntime(); stopRuntime = null; snapshot = CHECKING; misses = 0; }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => CHECKING;

// ------------------------------------------------------------------ pairing

const CSRF_HEADERS = { "content-type": "application/json", "x-grove-csrf": "1" };

/**
 * Pair this browser: create a device token on the server, then hand it to the extension. The token
 * goes straight from the response to postMessage and is never stored, rendered or logged. If the
 * extension does not accept it, the server-side device is deleted again.
 */
export async function pairExtension(deviceName: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher("/api/canvas/extension/devices", { method: "POST", headers: CSRF_HEADERS, body: JSON.stringify({ name: deviceName }) });
  } catch {
    throw new SignInError({ code: "NETWORK_OFFLINE", title: "Grove could not be reached", message: "This browser was not connected.", nextAction: "Check your connection, then try again." });
  }
  const body = await response.json().catch(() => ({})) as { device?: { id?: string; name?: string }; token?: string; canvasOrigin?: string | null; error?: string; code?: string };
  if (!response.ok || !body.token || !body.device?.id) {
    if (body.code === "DEVICE_LIMIT") throw new SignInError({ code: "DEVICE_LIMIT", title: "Too many connected browsers", message: body.error ?? "Your account has the maximum number of connected browsers.", nextAction: "Disconnect a browser you no longer use in Settings, then try again." });
    if (response.status === 401) throw new SignInError({ code: "AUTH_REQUIRED", title: "Your Grove session expired", message: "This browser was not connected.", nextAction: "Sign in to Grove again, then retry." });
    throw new SignInError({ code: body.code ?? "PAIR_FAILED", title: "This browser could not be connected", message: "Grove did not create a connection for this browser.", nextAction: "Try again in a moment.", technical: body.error });
  }
  const deviceId = body.device.id;
  const undo = () => fetcher(`/api/canvas/extension/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", headers: CSRF_HEADERS }).catch(() => undefined);
  let result: { ok?: boolean; reason?: string } | undefined;
  try {
    result = await extRequest<{ ok?: boolean; reason?: string }>("pair", { token: body.token, deviceName: body.device.name ?? deviceName, ...(body.canvasOrigin ? { canvasOrigin: body.canvasOrigin } : {}) }, 8000);
  } catch (error) {
    await undo();
    throw new SignInError({
      code: "EXTENSION_TIMEOUT", title: "The extension did not respond",
      message: "Grove sent the connection to the extension, but it did not confirm.",
      nextAction: "Reload this page and try again. If it keeps happening, reinstall the extension.",
      technical: error instanceof ExtensionTimeoutError ? error.message : undefined,
    });
  }
  if (!result?.ok) {
    await undo();
    throw new SignInError({ code: "PAIR_REJECTED", title: "The extension could not save the connection", message: reasonMessage(result?.reason), nextAction: "Try again from this page.", technical: result?.reason });
  }
}

// ------------------------------------------------------------------ hook

async function pair(deviceName: string) {
  await pairExtension(deviceName);
  if (inFlight) await inFlight; // a hello sent before pairing would report the old state
  await check();
}
function recheck() { void check(); }

export function useExtension(): ExtensionSnapshot & { pair(deviceName: string): Promise<void>; recheck(): void } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { status: current.status, state: current.state, pair, recheck };
}

/** Test hook: reset the shared store between tests. */
export function __resetExtensionStoreForTests() {
  stopRuntime?.(); stopRuntime = null; listeners.clear(); snapshot = CHECKING; misses = 0; inFlight = null;
}
export const __extensionStoreForTests = { accept, getSnapshot };
