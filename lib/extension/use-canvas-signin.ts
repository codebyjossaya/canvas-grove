"use client";

/**
 * Canvas sign-in through the Grove extension (Contract 2). Used by orientation step 5 and the
 * Settings Canvas connection card.
 *
 * The extension opens a sign-in tab, watches it, captures the Canvas session and posts it to
 * /api/extension/canvas-auth by itself; it reports progress with `signin` events. Those events only
 * make the UI fast. Whether Canvas is connected is decided by the server: the controller polls
 * GET /api/canvas/sessions/:id while a sign-in is running and on window focus, and reports
 * `connected` only when the server says the session is active.
 *
 * The state machine lives in `CanvasSignInController` (no React, injectable fetch/bridge/timers) so it
 * can be unit tested; `useCanvasSignIn` is a thin wrapper.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { toUiError, safeBlockedHostname, type UiError } from "@/components/ui/ui-errors";
import { parseInstitutionLink } from "@/lib/canvas/institution";
import { CANVAS_CONSENT_VERSION } from "@/lib/canvas/consent-version";
import { extRequest as bridgeRequest, ExtensionTimeoutError, reasonMessage, subscribeExtension, type ExtensionEvent, type SigninStage, type SigninStatus } from "./web-bridge";

export type SignInPhase = "idle" | "starting" | "awaiting-tab-click" | "signing-in" | "verifying" | "connected" | "error";
export type SignInSchool = { name: string; domain: string };
/** The server's public view of a Canvas session (publicHostedSession). */
export type ServerCanvasSession = {
  id: string;
  canvasOrigin: string;
  institutionName: string;
  state: "provisioning" | "awaiting-login" | "active" | "auth-expired" | "terminated" | "failed";
  updatedAt: string;
  interactiveAuthExpiresAt: string | null;
  lastError?: string;
};
export type CanvasSignInSnapshot = {
  phase: SignInPhase;
  account: { name: string } | null;
  session: { id: string; canvasOrigin: string } | null;
  error: UiError | null;
  /** The owner's already-connected Canvas session (server truth). `id` is additive to the contract. */
  existing: { connected: boolean; canvasOrigin: string; accountName?: string; id: string } | null;
  // ---- additive (not in the original contract) ----
  /** True until the first GET /api/canvas/sessions finishes. */
  loading: boolean;
  /** Last extension stage for this attempt, for precise copy. */
  stage: SigninStage | null;
  /** The user closed the sign-in tab before Canvas finished; offer focusTab() ("Reopen sign-in tab"). */
  tabClosed: boolean;
  /** When this attempt started (ms), for "Not seeing the tab?" fallbacks. */
  startedAt: number | null;
  /** The current (non-terminated) server session, including expired ones, for Settings. */
  serverSession: ServerCanvasSession | null;
};

export type SignInDeps = {
  fetch: typeof fetch;
  extRequest: <T = unknown>(type: "signin-start" | "signin-status" | "signin-focus" | "signin-cancel", payload: Record<string, unknown>, timeoutMs: number) => Promise<T>;
  subscribe: (listener: (event: ExtensionEvent) => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
};

export const SERVER_POLL_MS = 2000;
/** The extension expires a pending sign-in after 30 minutes; stop polling shortly after. */
export const MAX_ATTEMPT_MS = 31 * 60_000;
const IN_PROGRESS: ReadonlySet<SignInPhase> = new Set(["awaiting-tab-click", "signing-in", "verifying"]);
const LIVE_STAGES: ReadonlySet<SigninStage> = new Set(["opening", "needs-access", "signing-in", "verifying", "captured", "tab-closed"]);

class ApiError extends Error {
  constructor(message: string, public code: string, public status: number, public blockedHost?: string) { super(message); }
}

const CODE_MAP: Record<string, string> = {
  BROWSER_AUTH_EXPIRED: "CANVAS_AUTH_EXPIRED",
  INTERACTIVE_AUTH_TIMEOUT: "INTERACTIVE_AUTH_TIMEOUT",
  BROWSER_SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SERVER_UNAVAILABLE: "SERVER_UNAVAILABLE",
  NETWORK_OFFLINE: "NETWORK_OFFLINE",
  CANVAS_AUTH_NOT_VERIFIED: "CANVAS_AUTH_EXPIRED",
  CANVAS_SESSION_COOKIE_MISSING: "CANVAS_AUTH_EXPIRED",
  INVALID_CANVAS_URL: "INVALID_CANVAS_URL",
  BROWSER_NAVIGATION_BLOCKED: "NAVIGATION_BLOCKED",
};

/** Map any thrown value to a UiError, using the server's `code` when there is one. */
export function signInUiError(value: unknown): UiError {
  if (value && typeof value === "object" && "title" in value && "nextAction" in value && "code" in value) {
    const v = value as UiError;
    return { code: v.code, title: v.title, message: v.message, nextAction: v.nextAction, technical: v.technical, blockedHost: v.blockedHost };
  }
  if (value instanceof ExtensionTimeoutError) return extensionNotResponding();
  const code = value instanceof ApiError ? value.code : "UNKNOWN";
  return toUiError(value, CODE_MAP[code] ?? "UNKNOWN");
}

function extensionNotResponding(): UiError {
  return {
    code: "EXTENSION_TIMEOUT",
    title: "The Grove extension did not respond",
    message: "Grove could not ask the extension to open the Canvas sign-in tab.",
    nextAction: "Check that Grove for Canvas is installed, enabled and up to date, reload this page, then try again.",
  };
}

function reasonError(reason: string | undefined): UiError {
  const code = reason ?? "";
  const title = code === "permission-denied" ? "Canvas access was not allowed"
    : code === "expired" ? "Canvas sign-in timed out"
      : code.startsWith("capture-rejected") ? "Grove could not verify this Canvas sign-in"
        : code === "revoked" || code === "not-paired" ? "This browser is not connected to Grove"
          : "Canvas sign-in did not finish";
  return { code: "EXTENSION_SIGNIN_FAILED", title, message: reasonMessage(reason), nextAction: "", technical: reason || undefined };
}

const INITIAL: CanvasSignInSnapshot = Object.freeze({
  phase: "idle", account: null, session: null, error: null, existing: null,
  loading: true, stage: null, tabClosed: false, startedAt: null, serverSession: null,
}) as CanvasSignInSnapshot;

export class CanvasSignInController {
  private snap: CanvasSignInSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private op = 0;
  private pollTimer: unknown = undefined;
  private pollFailures = 0;
  private unsubscribe: (() => void) | null = null;
  private polling = false;

  constructor(private deps: SignInDeps) {}

  // ---------------------------------------------------------------- store plumbing
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snap;
  getServerSnapshot = () => INITIAL;
  /** Read through a method so TypeScript does not keep a narrowing across awaits. */
  private phaseNow(): SignInPhase { return this.snap.phase; }
  private set(patch: Partial<CanvasSignInSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Start listening to the extension and load the owner's sessions. Idempotent. */
  attach() {
    if (!this.unsubscribe) this.unsubscribe = this.deps.subscribe((event) => { if (event.type === "signin") this.onSigninEvent(event.status); });
    if (IN_PROGRESS.has(this.snap.phase)) this.schedulePoll(0);
    return this.load();
  }
  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopPoll();
  }

  // ---------------------------------------------------------------- server helpers
  private async api<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.deps.fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    } catch (error) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      throw new ApiError(error instanceof Error ? error.message : "Network request failed", offline ? "NETWORK_OFFLINE" : "SERVER_UNAVAILABLE", 0);
    }
    const value = await response.json().catch(() => ({})) as T & { error?: string; code?: string; blockedHost?: unknown };
    if (!response.ok) throw new ApiError(value.error || "Request failed", value.code || "REQUEST_FAILED", response.status, safeBlockedHostname(value.blockedHost));
    return value;
  }

  private existingFrom(session: ServerCanvasSession | null, accountName?: string): CanvasSignInSnapshot["existing"] {
    if (!session || session.state !== "active") return null;
    return { connected: true, canvasOrigin: session.canvasOrigin, id: session.id, ...(accountName ? { accountName } : {}) };
  }

  /** Reload the owner's sessions from the server and resume an in-flight attempt if the extension has one. */
  async load() {
    try {
      const { sessions } = await this.api<{ sessions: ServerCanvasSession[] }>("/api/canvas/sessions");
      const live = sessions.filter((item) => item.state !== "terminated" && item.state !== "failed");
      const current = live.find((item) => item.state === "active") ?? live[0] ?? null;
      const knownName = this.snap.existing?.id === current?.id ? this.snap.existing?.accountName : undefined;
      // Render server truth first; asking the extension can take up to its timeout when it is missing.
      this.set({ loading: false, serverSession: current, existing: this.existingFrom(current, knownName) });
      if (current && current.state !== "active" && !this.snap.session) this.set({ session: { id: current.id, canvasOrigin: current.canvasOrigin } });
      if (!current) return;
      const status = await this.extensionStatus(current.id);
      if (!status || this.snap.serverSession?.id !== current.id) return;
      if (current.state === "active") {
        if (status.account?.name && !knownName) this.set({ existing: this.existingFrom(current, status.account.name) });
        return;
      }
      // Resume: the extension still has a live sign-in for this pending session (e.g. after a reload).
      if (LIVE_STAGES.has(status.stage) && !IN_PROGRESS.has(this.snap.phase) && this.snap.phase !== "starting" && this.snap.session?.id === current.id) {
        this.set({ startedAt: this.deps.now() });
        this.onSigninEvent(status);
        this.schedulePoll(0);
      }
    } catch (error) {
      this.set({ loading: false, error: this.snap.error ?? signInUiError(error) });
    }
  }

  private async extensionStatus(sessionId: string): Promise<SigninStatus | null> {
    try {
      const status = await this.deps.extRequest<SigninStatus | null>("signin-status", { sessionId }, 1200);
      return status && status.sessionId === sessionId ? status : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- actions
  async start(school: SignInSchool | null) {
    if (this.snap.phase === "starting") return;
    if (!school) {
      this.set({ phase: "error", error: { code: "SCHOOL_REQUIRED", title: "Choose your school first", message: "Grove needs your school's Canvas address to open the right sign-in page.", nextAction: "" } });
      return;
    }
    let canvasOrigin: string, loginUrl: string;
    try {
      const parsed = parseInstitutionLink(school.domain);
      canvasOrigin = parsed.canvasOrigin;
      loginUrl = `${parsed.canvasOrigin}${parsed.loginPath}`;
    } catch (error) {
      this.set({ phase: "error", error: toUiError(error, "INVALID_CANVAS_URL") });
      return;
    }
    const op = ++this.op;
    this.stopPoll();
    this.set({ phase: "starting", error: null, account: null, stage: null, tabClosed: false, startedAt: this.deps.now() });
    try {
      const ready = await this.prepareSession(school, canvasOrigin);
      if (op !== this.op) return;
      this.set({ session: { id: ready.id, canvasOrigin: ready.canvasOrigin }, serverSession: ready });
      const result = await this.deps.extRequest<{ ok?: boolean; reason?: string }>("signin-start", { sessionId: ready.id, canvasOrigin: ready.canvasOrigin, loginUrl, schoolName: school.name }, 8000);
      if (op !== this.op) return;
      if (!result?.ok) { this.set({ phase: "error", error: reasonError(result?.reason) }); return; }
      // The extension may already have sent a newer stage while we awaited the reply.
      if (this.phaseNow() === "starting") this.set({ phase: "awaiting-tab-click", stage: this.snap.stage ?? "opening" });
      this.schedulePoll(SERVER_POLL_MS);
    } catch (error) {
      if (op === this.op) this.set({ phase: "error", error: signInUiError(error) });
    }
  }

  /** Reuse a pending/expired session for the same Canvas site, or create one; then open a fresh attempt. */
  private async prepareSession(school: SignInSchool, canvasOrigin: string): Promise<ServerCanvasSession> {
    const current = this.snap.serverSession;
    if (current && current.state !== "active") {
      if (current.canvasOrigin === canvasOrigin) {
        try { return await this.newAttempt(current.id); }
        catch (error) { if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error; }
      }
      // A stale attempt or a different school: revoke the pending session before creating a new one.
      await this.api(`/api/canvas/sessions/${encodeURIComponent(current.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    const created = await this.api<{ session: ServerCanvasSession }>("/api/canvas/sessions", {
      method: "POST",
      body: JSON.stringify({ signInLink: school.domain, institutionName: school.name.trim().slice(0, 100), consent: true, consentVersion: CANVAS_CONSENT_VERSION }),
    });
    return this.newAttempt(created.session.id);
  }

  private async newAttempt(sessionId: string) {
    const value = await this.api<{ session: ServerCanvasSession }>(`/api/canvas/sessions/${encodeURIComponent(sessionId)}/auth-attempt`, { method: "POST" });
    return value.session;
  }

  focusTab() {
    const session = this.snap.session;
    if (!session) return;
    this.set({ tabClosed: false });
    this.deps.extRequest<{ ok?: boolean; reason?: string }>("signin-focus", { sessionId: session.id }, 4000).then((result) => {
      if (result && result.ok === false) this.set({ phase: "error", error: reasonError(result.reason) });
    }, (error) => this.set({ error: signInUiError(error) }));
  }

  async cancel() {
    const session = this.snap.session;
    ++this.op;
    this.stopPoll();
    this.set({ phase: "idle", error: null, account: null, stage: null, tabClosed: false, startedAt: null });
    if (!session) return;
    await this.deps.extRequest("signin-cancel", { sessionId: session.id }, 2000).catch(() => undefined);
    if (this.snap.serverSession?.id === session.id && this.snap.serverSession.state === "active") return;
    await this.api(`/api/canvas/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => undefined);
    this.set({ session: null, serverSession: this.snap.serverSession?.id === session.id ? null : this.snap.serverSession });
  }

  retry(school: SignInSchool | null) {
    const fallback = this.snap.serverSession ? { name: this.snap.serverSession.institutionName, domain: this.snap.serverSession.canvasOrigin } : null;
    return this.start(school ?? fallback);
  }

  /** Additive: revoke the connected session (Settings "Disconnect"). Throws a UiError-shaped value. */
  async disconnect() {
    const current = this.snap.serverSession;
    if (!current) return;
    ++this.op;
    this.stopPoll();
    try { await this.api(`/api/canvas/sessions/${encodeURIComponent(current.id)}`, { method: "DELETE" }); }
    catch (error) { throw signInUiError(error); }
    this.set({ phase: "idle", session: null, serverSession: null, existing: null, account: null, stage: null, error: null, tabClosed: false, startedAt: null });
  }

  /** Additive: re-verify the connected session against Canvas (`?verify=1`). Throws a UiError-shaped value. */
  async verify(): Promise<void> {
    const current = this.snap.serverSession;
    if (!current) return;
    try {
      const value = await this.api<{ session: ServerCanvasSession }>(`/api/canvas/sessions/${encodeURIComponent(current.id)}?verify=1`);
      this.set({ serverSession: value.session, existing: this.existingFrom(value.session, this.snap.existing?.accountName) });
      if (value.session.state !== "active") throw new ApiError("Canvas needs you to sign in again", "BROWSER_AUTH_EXPIRED", 409);
    } catch (error) { throw signInUiError(error); }
  }

  /** Window focus / visibility: check the server right away while a sign-in is running. */
  poke() { if (IN_PROGRESS.has(this.snap.phase)) this.schedulePoll(0); }

  // ---------------------------------------------------------------- extension events
  onSigninEvent(status: SigninStatus) {
    const session = this.snap.session;
    if (!session || status.sessionId !== session.id) return;
    if (this.snap.phase === "connected" || this.snap.phase === "starting" && status.stage === "cancelled") return;
    const account = status.account ? { name: status.account.name } : this.snap.account;
    switch (status.stage) {
      case "opening":
      case "needs-access":
        this.set({ phase: "awaiting-tab-click", stage: status.stage, tabClosed: false, error: null });
        break;
      case "signing-in":
        this.set({ phase: "signing-in", stage: status.stage, tabClosed: false, error: null });
        break;
      case "verifying":
        this.set({ phase: "verifying", stage: status.stage, account, tabClosed: false, error: null });
        break;
      case "captured":
        this.set({ phase: "verifying", stage: status.stage, account, tabClosed: false, error: null });
        this.schedulePoll(0);
        return;
      case "tab-closed":
        this.set({ stage: status.stage, tabClosed: true, phase: this.snap.phase === "error" || this.snap.phase === "idle" ? "signing-in" : this.snap.phase });
        break;
      case "failed":
        this.set({ phase: "error", stage: status.stage, error: reasonError(status.reason), tabClosed: false });
        // The capture may still have landed (e.g. a late reply); let the server have the last word once.
        this.schedulePoll(0, true);
        return;
      case "cancelled":
        ++this.op;
        this.stopPoll();
        this.set({ phase: "idle", stage: status.stage, tabClosed: false, account: null, error: null });
        return;
    }
    if (!this.pollTimer) this.schedulePoll(SERVER_POLL_MS);
  }

  // ---------------------------------------------------------------- server polling
  private stopPoll() {
    if (this.pollTimer !== undefined) this.deps.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedulePoll(delay: number, once = false) {
    this.stopPoll();
    const op = this.op;
    this.pollTimer = this.deps.setTimeout(() => { this.pollTimer = undefined; void this.tick(op, once); }, delay);
  }

  /** One server check. Exposed for tests; normal callers use poke(). */
  async tick(op = this.op, once = false) {
    const session = this.snap.session;
    if (!session || op !== this.op || this.polling) return;
    if (!once && !IN_PROGRESS.has(this.snap.phase)) return;
    this.polling = true;
    try {
      const { session: server } = await this.api<{ session: ServerCanvasSession }>(`/api/canvas/sessions/${encodeURIComponent(session.id)}`);
      if (op !== this.op) return;
      this.pollFailures = 0;
      if (server.state === "active") {
        this.set({ phase: "connected", serverSession: server, existing: this.existingFrom(server, this.snap.account?.name), error: null, tabClosed: false });
        return;
      }
      this.set({ serverSession: server });
      if (server.lastError === "INTERACTIVE_AUTH_TIMEOUT" || ["auth-expired", "failed", "terminated"].includes(server.state)) {
        const timedOut = server.lastError === "INTERACTIVE_AUTH_TIMEOUT" || server.state === "auth-expired";
        this.set({ phase: "error", error: toUiError(timedOut ? "The sign-in attempt expired" : "The Canvas connection attempt ended", timedOut ? "INTERACTIVE_AUTH_TIMEOUT" : "SESSION_NOT_FOUND") });
        return;
      }
    } catch (error) {
      if (op !== this.op) return;
      this.pollFailures += 1;
      const gone = error instanceof ApiError && error.status === 404;
      if (gone || this.pollFailures >= 3) {
        this.set({ phase: "error", error: signInUiError(gone ? new ApiError("Hosted session not found", "BROWSER_SESSION_NOT_FOUND", 404) : error) });
        return;
      }
    } finally {
      this.polling = false;
    }
    if (once || op !== this.op) return;
    if (this.snap.startedAt !== null && this.deps.now() - this.snap.startedAt > MAX_ATTEMPT_MS) {
      this.set({ phase: "error", error: reasonError("expired") });
      return;
    }
    if (IN_PROGRESS.has(this.snap.phase)) this.schedulePoll(SERVER_POLL_MS);
  }
}

function browserDeps(): SignInDeps {
  return {
    fetch: (...args) => fetch(...args),
    extRequest: (type, payload, timeoutMs) => bridgeRequest(type, payload, timeoutMs),
    subscribe: subscribeExtension,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    now: () => Date.now(),
  };
}

export type CanvasSignIn = CanvasSignInSnapshot & {
  start(): Promise<void>;
  focusTab(): void;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  // ---- additive ----
  disconnect(): Promise<void>;
  verify(): Promise<void>;
  refresh(): Promise<void>;
};

export function useCanvasSignIn(opts: { school: SignInSchool | null }): CanvasSignIn {
  const [controller] = useState(() => new CanvasSignInController(browserDeps()));
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => {
    void controller.attach();
    const onFocus = () => { if (document.visibilityState === "visible") controller.poke(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      controller.detach();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [controller]);
  const school = opts.school;
  return {
    ...snap,
    start: () => controller.start(school),
    focusTab: () => controller.focusTab(),
    cancel: () => controller.cancel(),
    retry: () => controller.retry(school),
    disconnect: () => controller.disconnect(),
    verify: () => controller.verify(),
    refresh: () => controller.load(),
  };
}
