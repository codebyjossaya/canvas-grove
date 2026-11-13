"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chooseDisplaySize } from "./display-size";
import { ThemeControl } from "./theme-provider";
import { safeBlockedHostname } from "./ui-errors";
import { InteractiveAuthCountdown } from "./interactive-auth-countdown";
import { shouldShowInteractiveAuthDeadline } from "@/lib/interactive-auth-deadline";
import styles from "./secure-browser-popup.module.css";

type PopupSession = { id: string; canvasOrigin: string; institutionName: string; state: "provisioning" | "awaiting-login" | "active" | "auth-expired" | "terminated" | "failed"; interactiveAuthExpiresAt: string | null; lastError?: string };
type Stage = "pending" | "connecting" | "ready" | "finishing" | "connected" | "ended" | "error";
const POLL_MS = 3000;
// After the viewer reports the browser landed on Canvas the remote page is
// never shown again. The server completes sign-in on its own (durable auth
// monitor); this window speeds it up with /confirm and watches the session
// status, and gives up with an actionable error after FINISH_WINDOW_MS.
export const FINISH_WINDOW_MS = 30_000;
const FINISH_RETRY_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
type Renderer = "pixels" | "pixels-auto" | "mirror";

/**
 * Dev/test-only renderer override (?renderer=mirror|pixels on this popup's URL).
 * It is forwarded to the one-time live link; the orchestrator honours it only
 * when SIGNIN_RENDERER_OVERRIDE=allow, otherwise the session's configured
 * renderer (SIGNIN_RENDERER, default pixels) is used.
 */
export function rendererOverrideQuery(search: string) {
  const value = new URLSearchParams(search).get("renderer");
  return value === "mirror" || value === "pixels" ? `?renderer=${value}` : "";
}

class PopupRequestError extends Error {
  constructor(message: string, public code: string, public blockedHost?: string) { super(message); }
}

async function request<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const value = await response.json().catch(() => ({})) as T & { error?: string; code?: string; blockedHost?: unknown };
  if (!response.ok) throw new PopupRequestError(value.error || "The secure browser could not connect", value.code || "REQUEST_FAILED", safeBlockedHostname(value.blockedHost));
  return value;
}

function notify(type: string, detail?: string, code?: string, blockedHost?: string) {
  if (window.opener && !window.opener.closed) window.opener.postMessage({ source: "canvas-grove-popup", type, detail, code, blockedHost }, window.location.origin);
}

/** Close this window; phones often open it as a tab that may refuse to close, so fall back to the app. */
function closeOrReturn() {
  window.close();
  window.setTimeout(() => { if (!window.closed) window.location.replace("/"); }, 400);
}

function signInHost(session: PopupSession | null) {
  if (!session) return "";
  if (session.institutionName) return session.institutionName;
  try { return new URL(session.canvasOrigin).host; } catch { return session.canvasOrigin; }
}

function LockIcon() {
  return <svg className={styles.lock} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"/></svg>;
}

export function SecureBrowserPopup({ sessionId }: { sessionId?: string }) {
  const [stage, setStage] = useState<Stage>(sessionId ? "connecting" : "pending");
  const [viewerUrl, setViewerUrl] = useState("");
  const [session, setSession] = useState<PopupSession | null>(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [blockedHost, setBlockedHost] = useState<string>();
  const [notice, setNotice] = useState("");
  const [renderer, setRenderer] = useState<Renderer>("pixels");
  const [mirrorSeen, setMirrorSeen] = useState(false);
  const iframe = useRef<HTMLIFrameElement | null>(null);
  const connecting = useRef(false);
  const ended = useRef(false);
  const finishing = useRef(false);

  const connect = useCallback(async () => {
    if (!sessionId || connecting.current || ended.current) return;
    connecting.current = true; finishing.current = false; setStage("connecting"); setError(""); setErrorCode(""); setBlockedHost(undefined); setNotice("");
    try {
      const status = await request<{ session: PopupSession }>(`/api/canvas/sessions/${sessionId}`);
      setSession(status.session);
      if (status.session.lastError === "INTERACTIVE_AUTH_TIMEOUT") {
        ended.current = true;
        setStage("ended");
        setErrorCode("INTERACTIVE_AUTH_TIMEOUT");
        notify("ended", "Secure sign-in time expired", "INTERACTIVE_AUTH_TIMEOUT");
        return;
      }
      if (!status.session.interactiveAuthExpiresAt) {
        setStage("pending");
        notify("attempt-required", "Preparing a new secure sign-in attempt");
        return;
      }
      const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
      const size = chooseDisplaySize({ availWidth: window.screen.availWidth, availHeight: window.screen.availHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, devicePixelRatio: window.devicePixelRatio, coarsePointer });
      const value = await request<{ url: string }>(`/api/canvas/sessions/${sessionId}/connect`, { method: "POST", body: JSON.stringify({ width: size.width, height: size.height, dpr: size.dpr, ...(size.mobile ? { mobile: true } : {}) }), signal: AbortSignal.timeout(30_000) });
      // The fragment survives the /live redirect and lets the viewer match this page's theme.
      const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      setRenderer("pixels"); setMirrorSeen(false);
      setViewerUrl(`${value.url}${rendererOverrideQuery(window.location.search)}#theme=${theme}`); setStage("ready"); notify("viewer-loading");
    } catch (value) {
      const message = value instanceof Error ? value.message : "The secure browser could not connect";
      const code = value instanceof PopupRequestError ? value.code : "BROWSER_HOST_ERROR";
      const host = value instanceof PopupRequestError ? value.blockedHost : undefined;
      setError(message); setErrorCode(code); setBlockedHost(host); setStage("error"); notify("failed", message, code, host);
    } finally { connecting.current = false; }
  }, [sessionId]);

  const finishSignedIn = useCallback(() => {
    if (ended.current) return;
    ended.current = true; finishing.current = false;
    iframe.current?.contentWindow?.postMessage({ source: "canvas-grove-popup", type: "viewer-complete" }, window.location.origin);
    setViewerUrl(""); setStage("connected"); notify("completed");
    // Leave "Signed in ✓" on screen briefly, then close.
    window.setTimeout(closeOrReturn, 850);
  }, []);

  // The viewer saw the browser land on Canvas. Hide it at once (it never comes
  // back) and finish: /confirm is the fast path, the status poll sees the
  // server-side monitor's completion, whichever is first wins.
  const confirmSignIn = useCallback(async () => {
    if (!sessionId || finishing.current || ended.current) return;
    finishing.current = true; setStage("finishing"); setError(""); setNotice("");
    const deadline = Date.now() + FINISH_WINDOW_MS;
    let confirmAllowed = true;
    while (Date.now() < deadline && !ended.current && finishing.current) {
      if (confirmAllowed) {
        try {
          const value = await request<{ confirmed: boolean; session: PopupSession }>(`/api/canvas/sessions/${sessionId}/confirm`, { method: "POST", body: "{}", signal: AbortSignal.timeout(Math.max(1_000, Math.min(8_000, deadline - Date.now()))) });
          setSession(value.session);
          if (value.confirmed) { finishSignedIn(); return; }
        } catch (value) {
          if (value instanceof PopupRequestError && value.code === "RATE_LIMITED") confirmAllowed = false;
        }
      }
      try {
        const value = await request<{ session: PopupSession }>(`/api/canvas/sessions/${sessionId}`, { signal: AbortSignal.timeout(5_000) });
        setSession(value.session);
        if (value.session.state === "active") { finishSignedIn(); return; }
        if (["terminated", "failed", "auth-expired"].includes(value.session.state)) break;
      } catch { /* transient: keep trying until the deadline */ }
      if (ended.current || !finishing.current) return;
      await sleep(FINISH_RETRY_MS);
    }
    if (ended.current || !finishing.current) return;
    // Never resume the remote view after landing: the Canvas page is never shown.
    finishing.current = false;
    const message = "You reached Canvas, but Canvas Grove could not finish saving the sign-in. Retry secure sign-in to try again.";
    setViewerUrl(""); setStage("error"); setErrorCode("SIGN_IN_NOT_FINISHED"); setBlockedHost(undefined); setError(message);
    notify("failed", message, "SIGN_IN_NOT_FINISHED");
  }, [finishSignedIn, sessionId]);

  useEffect(() => {
    notify("shell-ready");
    if (!sessionId) return;
    const timer = window.setTimeout(() => void connect(), 0);
    return () => window.clearTimeout(timer);
  }, [connect, sessionId]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === window.opener) {
        const openerMessage = event.data as { source?: string; type?: string };
        if (openerMessage.source === "canvas-grove-opener" && openerMessage.type === "end") {
          ended.current = true; setViewerUrl(""); setStage("ended"); closeOrReturn();
        }
        return;
      }
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow) return;
      const message = event.data as { source?: string; type?: string; detail?: string };
      if (message.source !== "canvas-grove-viewer") return;
      // "signed-in" means the server already saved the session and released the browser.
      if (message.type === "signed-in-pending" || message.type === "signed-in") { void confirmSignIn(); return; }
      // The viewer reports which renderer is showing the page (DOM mirror or classic pixels).
      if (message.type === "renderer") {
        if (message.detail === "mirror" || message.detail === "pixels" || message.detail === "pixels-auto") setRenderer(message.detail);
        if (message.detail === "mirror") setMirrorSeen(true);
        return;
      }
      // Once landing is reported the live viewer is torn down on purpose:
      // disconnect and expiry signals are expected and never shown.
      if (finishing.current || ended.current) return;
      if (message.type === "ws-ready") { setStage("ready"); notify("ws-ready"); }
      if (["failed", "disconnected", "authorization-expired"].includes(message.type || "")) { setViewerUrl(""); setStage("error"); setErrorCode(message.type === "authorization-expired" ? "BROWSER_AUTH_EXPIRED" : "BROWSER_HOST_ERROR"); setBlockedHost(undefined); setError(message.detail || "The live viewer disconnected"); notify(message.type || "failed", message.detail); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [confirmSignIn]);
  // The on-screen keyboard shrinks only this page's visual viewport, not the
  // iframe's; tell the viewer how much of it remains visible so it can keep the
  // tapped field above the keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !viewerUrl) return;
    const report = () => {
      const frame = iframe.current;
      if (!frame?.contentWindow) return;
      const rect = frame.getBoundingClientRect();
      frame.contentWindow.postMessage({ source: "canvas-grove-popup", type: "visible-area", bottom: Math.round(vv.offsetTop + vv.height - rect.top) }, window.location.origin);
    };
    vv.addEventListener("resize", report); vv.addEventListener("scroll", report);
    return () => { vv.removeEventListener("resize", report); vv.removeEventListener("scroll", report); };
  }, [viewerUrl]);
  useEffect(() => {
    if (!sessionId) return;
    let timer: number | undefined;
    // Always watch the session: the server can finish sign-in on its own (even
    // when the landed signal never reached this window) and this window must
    // then close instead of sitting on a stale view.
    const poll = async () => {
      if (finishing.current) { timer = window.setTimeout(poll, POLL_MS); return; }
      try {
        const value = await request<{ session: PopupSession }>(`/api/canvas/sessions/${sessionId}`);
        setSession(value.session);
        if (value.session.state === "active") { finishSignedIn(); return; }
        if (["terminated", "failed", "auth-expired"].includes(value.session.state)) {
          ended.current = true; setViewerUrl(""); setStage("ended"); notify("ended", value.session.state); return;
        }
      } catch { /* A transient status failure must not tear down an active sign-in. */ }
      if (!ended.current) timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => { if (timer) window.clearTimeout(timer); };
  }, [finishSignedIn, sessionId]);
  const host = signInHost(session);
  const navigationBlocked = errorCode === "BROWSER_NAVIGATION_BLOCKED";
  const interactiveTimedOut = errorCode === "INTERACTIVE_AUTH_TIMEOUT";
  const expireInteractiveAttempt = () => {
    ended.current = true;
    setViewerUrl("");
    setStage("ended");
    setErrorCode("INTERACTIVE_AUTH_TIMEOUT");
    notify("ended", "Secure sign-in time expired", "INTERACTIVE_AUTH_TIMEOUT");
  };
  const viewerVisible = Boolean(viewerUrl) && stage !== "finishing";
  // Only offered when the session runs the DOM mirror: lets the user force the classic (pixel) view and back.
  const toggleRenderer = () => iframe.current?.contentWindow?.postMessage({ source: "canvas-grove-popup", type: "renderer-toggle" }, window.location.origin);
  const rendererToggle = viewerVisible && (renderer === "mirror" || renderer === "pixels-auto" || renderer === "pixels" && mirrorSeen);
  return <main className={styles.shell}>
    <header className={styles.toolbar}>
      <div className={styles.identity}><LockIcon/><p><strong>Secure browser</strong>{host ? <span> — you&apos;re signing in to {host}</span> : null}</p></div>
      <div className={styles.actions}>
        {session && shouldShowInteractiveAuthDeadline(session) && !interactiveTimedOut && <div className={styles.deadline}><InteractiveAuthCountdown expiresAt={session.interactiveAuthExpiresAt!} surface="header" onExpire={expireInteractiveAttempt}/></div>}
        {rendererToggle && <button type="button" className={styles.close} onClick={toggleRenderer}>{renderer === "mirror" ? "Switch to classic view" : "Switch to page view"}</button>}
        <ThemeControl compact/>
        <button type="button" className={styles.close} onClick={closeOrReturn}>End session</button>
      </div>
    </header>
    <section className={styles.stage} aria-live="polite">
      {viewerUrl && <iframe ref={iframe} src={viewerUrl} title="Secure Canvas live browser" allow="fullscreen" className={viewerVisible ? undefined : styles.hidden} aria-hidden={viewerVisible ? undefined : true}/>}
      {stage === "finishing" && <div className={styles.placeholder}><span className={styles.line}/><h1>Finishing sign-in…</h1></div>}
      {!viewerUrl && <div className={styles.placeholder} role={stage === "error" || interactiveTimedOut ? "alert" : undefined}>{(stage === "connecting" || stage === "pending") && <span className={styles.line}/>}<h1>{stage === "pending" || stage === "connecting" ? "Preparing secure browser" : stage === "connected" ? "Signed in ✓" : interactiveTimedOut ? "Secure sign-in time expired" : stage === "ended" ? "This sign-in session has ended" : navigationBlocked ? "Institution sign-in redirect blocked" : stage === "error" ? "Secure browser needs attention" : "Opening institution sign-in"}</h1>{navigationBlocked ? <div className={styles.blockedCopy}>{blockedHost&&<p className={styles.blockedHost}><span>Blocked hostname</span><code>{blockedHost}</code></p>}<p>Canvas Grove stopped this destination before showing it to you. Confirm the hostname belongs to your institution. If it does, retry or reconnect with that exact sign-in domain; otherwise cancel the session.</p></div> : <p className={stage === "error" || interactiveTimedOut ? styles.error : undefined}>{error || (stage === "pending" || stage === "connecting" ? "Canvas Grove is reserving your isolated browser. This window will continue automatically." : stage === "connected" ? "Canvas is connected. This window will close." : interactiveTimedOut ? "This browser is closed. Return to Canvas Grove to start a new secure sign-in; reopening cannot reset the timer." : stage === "ended" ? "Return to Canvas Grove to reconnect or revoke this session." : "Only enter credentials after your institution sign-in page appears.")}</p>}{interactiveTimedOut ? <button type="button" className={styles.retry} onClick={() => { window.opener?.focus(); closeOrReturn(); }}>Return to Canvas Grove</button> : stage === "error" && <div className={styles.errorActions}><button type="button" className={styles.retry} onClick={() => void connect()}>Retry secure sign-in</button><button type="button" className={styles.cancel} onClick={closeOrReturn}>Close and return</button></div>}</div>}
      {notice && viewerVisible && <div className={styles.status} role="status">{notice}</div>}
    </section>
  </main>;
}
