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
// After the viewer reports the browser landed on Canvas, confirm server-side
// for up to this long before showing the viewer again.
const CONFIRM_WINDOW_MS = 10_000;
const CONFIRM_RETRY_MS = 600;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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
      setViewerUrl(`${value.url}#theme=${theme}`); setStage("ready"); notify("viewer-loading");
    } catch (value) {
      const message = value instanceof Error ? value.message : "The secure browser could not connect";
      const code = value instanceof PopupRequestError ? value.code : "BROWSER_HOST_ERROR";
      const host = value instanceof PopupRequestError ? value.blockedHost : undefined;
      setError(message); setErrorCode(code); setBlockedHost(host); setStage("error"); notify("failed", message, code, host);
    } finally { connecting.current = false; }
  }, [sessionId]);

  const finishSignedIn = useCallback(() => {
    ended.current = true; setViewerUrl(""); setStage("connected"); notify("completed");
    closeOrReturn();
  }, []);

  // The viewer saw the browser land on Canvas. Hide it at once, confirm on the
  // server, and close only once the session is confirmed active.
  const confirmSignIn = useCallback(async () => {
    if (!sessionId || finishing.current || ended.current) return;
    finishing.current = true; setStage("finishing"); setError(""); setNotice("");
    const deadline = Date.now() + CONFIRM_WINDOW_MS;
    while (Date.now() < deadline && !ended.current && finishing.current) {
      try {
        const value = await request<{ confirmed: boolean; session: PopupSession }>(`/api/canvas/sessions/${sessionId}/confirm`, { method: "POST", body: "{}", signal: AbortSignal.timeout(8_000) });
        setSession(value.session);
        if (value.confirmed) { finishSignedIn(); return; }
      } catch (value) {
        if (value instanceof PopupRequestError && value.code === "RATE_LIMITED") break;
      }
      await sleep(CONFIRM_RETRY_MS);
    }
    if (ended.current || !finishing.current) return;
    finishing.current = false;
    setStage("ready");
    setNotice("Still finishing sign-in. This window will close on its own once Canvas confirms.");
    iframe.current?.contentWindow?.postMessage({ source: "canvas-grove-popup", type: "viewer-resume" }, window.location.origin);
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
      if (message.type === "signed-in-pending") { void confirmSignIn(); return; }
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
    const poll = async () => {
      if (window.opener && !window.opener.closed) {
        timer = window.setTimeout(poll, POLL_MS);
        return;
      }
      try {
        const value = await request<{ session: PopupSession }>(`/api/canvas/sessions/${sessionId}`);
        setSession(value.session);
        if (value.session.state === "active") {
          ended.current = true; setViewerUrl(""); setStage("connected"); notify("completed");
          window.setTimeout(() => window.close(), 850);
          window.setTimeout(() => { if (!window.closed) window.location.replace("/"); }, 1250);
          return;
        }
        if (["terminated", "failed", "auth-expired"].includes(value.session.state)) {
          ended.current = true; setViewerUrl(""); setStage("ended"); notify("ended", value.session.state); return;
        }
      } catch { /* A transient status failure must not tear down an active sign-in. */ }
      if (!ended.current) timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => { if (timer) window.clearTimeout(timer); };
  }, [sessionId]);
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
  return <main className={styles.shell}>
    <header className={styles.toolbar}>
      <div className={styles.identity}><LockIcon/><p><strong>Secure browser</strong>{host ? <span> — you&apos;re signing in to {host}</span> : null}</p></div>
      <div className={styles.actions}>
        {session && shouldShowInteractiveAuthDeadline(session) && !interactiveTimedOut && <div className={styles.deadline}><InteractiveAuthCountdown expiresAt={session.interactiveAuthExpiresAt!} surface="header" onExpire={expireInteractiveAttempt}/></div>}
        <ThemeControl compact/>
        <button type="button" className={styles.close} onClick={closeOrReturn}>End session</button>
      </div>
    </header>
    <section className={styles.stage} aria-live="polite">
      {viewerUrl && <iframe ref={iframe} src={viewerUrl} title="Secure Canvas live browser" allow="fullscreen" className={viewerVisible ? undefined : styles.hidden} aria-hidden={viewerVisible ? undefined : true}/>}
      {stage === "finishing" && <div className={styles.placeholder}><span className={styles.line}/><h1>Finishing sign-in…</h1></div>}
      {!viewerUrl && <div className={styles.placeholder} role={stage === "error" || interactiveTimedOut ? "alert" : undefined}>{(stage === "connecting" || stage === "pending") && <span className={styles.line}/>}<h1>{stage === "pending" || stage === "connecting" ? "Preparing secure browser" : stage === "connected" ? "Canvas connected" : interactiveTimedOut ? "Secure sign-in time expired" : stage === "ended" ? "This sign-in session has ended" : navigationBlocked ? "Institution sign-in redirect blocked" : stage === "error" ? "Secure browser needs attention" : "Opening institution sign-in"}</h1>{navigationBlocked ? <div className={styles.blockedCopy}>{blockedHost&&<p className={styles.blockedHost}><span>Blocked hostname</span><code>{blockedHost}</code></p>}<p>Canvas Grove stopped this destination before showing it to you. Confirm the hostname belongs to your institution. If it does, retry or reconnect with that exact sign-in domain; otherwise cancel the session.</p></div> : <p className={stage === "error" || interactiveTimedOut ? styles.error : undefined}>{error || (stage === "pending" || stage === "connecting" ? "Canvas Grove is reserving your isolated browser. This window will continue automatically." : stage === "connected" ? "Authentication was detected automatically. This window will close." : interactiveTimedOut ? "This browser is closed. Return to Canvas Grove to start a new secure sign-in; reopening cannot reset the timer." : stage === "ended" ? "Return to Canvas Grove to reconnect or revoke this session." : "Only enter credentials after your institution sign-in page appears.")}</p>}{interactiveTimedOut ? <button type="button" className={styles.retry} onClick={() => { window.opener?.focus(); closeOrReturn(); }}>Return to Canvas Grove</button> : stage === "error" && <div className={styles.errorActions}><button type="button" className={styles.retry} onClick={() => void connect()}>Retry secure sign-in</button><button type="button" className={styles.cancel} onClick={closeOrReturn}>Close and return</button></div>}</div>}
      {notice && viewerVisible && <div className={styles.status} role="status">{notice}</div>}
    </section>
  </main>;
}
