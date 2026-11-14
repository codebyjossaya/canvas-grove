"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppLink } from "@/components/ui/app-link";
import { GroveMark } from "@/components/ui/icons";
import { BRIDGE, EXTENSION_DOWNLOAD_URL } from "@/lib/extension/links";
import styles from "./extension.module.css";

type Phase = "checking" | "missing" | "ready" | "pairing" | "done" | "error";
type BridgeMessage = { source?: string; type?: string; reason?: string };

function guessDeviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const subscribeNever = () => () => undefined;
const csrf = { "content-type": "application/json", "x-grove-csrf": "1" };

export function ExtensionConnect() {
  const [phase, setPhaseState] = useState<Phase>("checking");
  const phaseRef = useRef<Phase>("checking");
  const setPhase = useCallback((next: Phase) => { phaseRef.current = next; setPhaseState(next); }, []);
  const guessed = useSyncExternalStore(subscribeNever, guessDeviceName, () => "");
  const [typedName, setTypedName] = useState<string | null>(null);
  const name = typedName ?? guessed;
  const [message, setMessage] = useState("");
  const pairedDevice = useRef<string | null>(null);

  const ping = useCallback(() => window.postMessage({ source: BRIDGE.web, type: "ping" }, window.location.origin), []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== BRIDGE.extension) return;
      if (event.data.type === "present" && (phaseRef.current === "checking" || phaseRef.current === "missing")) setPhase("ready");
      if (event.data.type === "paired") setPhase("done");
      if (event.data.type === "pair-failed") { setMessage("The extension could not save the connection."); setPhase("error"); }
    };
    window.addEventListener("message", onMessage);
    ping();
    const timer = window.setTimeout(() => { if (phaseRef.current === "checking") setPhase("missing"); }, 1500);
    return () => { window.removeEventListener("message", onMessage); window.clearTimeout(timer); };
  }, [ping, setPhase]);

  async function connect() {
    setPhase("pairing"); setMessage("");
    try {
      const response = await fetch("/api/canvas/extension/devices", { method: "POST", headers: csrf, body: JSON.stringify({ name }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage(body.error ?? "Could not connect this browser."); setPhase("error"); return; }
      pairedDevice.current = body.device.id;
      window.postMessage({ source: BRIDGE.web, type: "pair", token: body.token, deviceName: body.device.name, canvasOrigin: body.canvasOrigin }, window.location.origin);
      // The extension acknowledges through the same bridge; if it never does, undo the pairing.
      window.setTimeout(() => {
        if (phaseRef.current !== "pairing") return;
        void fetch(`/api/canvas/extension/devices/${pairedDevice.current}`, { method: "DELETE", headers: csrf });
        setMessage("The extension did not respond. Reload this page and try again.");
        setPhase("error");
      }, 5000);
    } catch { setMessage("Could not reach Canvas Grove."); setPhase("error"); }
  }

  return <main className={`page ${styles.page}`}>
    <section className={`panel ${styles.card}`} aria-labelledby="connect-title">
      <div className={styles.brand}><GroveMark /><span>Grove for Canvas</span></div>
      {phase === "done" ? <>
        <h1 id="connect-title">Browser connected</h1>
        <p><span className="chip success">Connected</span></p>
        <p>This browser can now complete Canvas sign-in for Grove. Your next step is to connect Canvas; Grove will show the Canvas account it finds before anything is saved.</p>
        <div className={styles.actions}><AppLink className="button primary large" href="/settings#connection">Connect Canvas</AppLink><AppLink className="button secondary large" href="/settings#extension">Settings</AppLink></div>
      </> : phase === "missing" ? <>
        <h1 id="connect-title">Install the extension first</h1>
        <p>Canvas Grove could not find the Grove for Canvas extension in this browser. Install it, then check again.</p>
        <div className={styles.actions}>
          <a className="button primary large" href={EXTENSION_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Get the extension</a>
          <button className="button secondary large" type="button" onClick={() => { setPhase("checking"); ping(); window.setTimeout(() => { if (phaseRef.current === "checking") setPhase("missing"); }, 1500); }}>Check again</button>
        </div>
      </> : <>
        <h1 id="connect-title">Connect this browser</h1>
        <p>Canvas Grove uses this extension to let you sign in on your own browser, then securely connect that Canvas session to Grove.</p>
        <ul className={styles.facts}>
          <li><strong>What it can do:</strong> after you approve the exact Canvas site, read that site&apos;s Canvas session and send it to Grove over an encrypted connection.</li>
          <li><strong>What it cannot do:</strong> read your institution password, identity-provider cookies, Grove password, or unrelated sites.</li>
          <li><strong>You confirm the account:</strong> Grove shows the Canvas identity detected in this browser before the session is saved.</li>
          <li><strong>You stay in control:</strong> disconnect this browser at any time from Settings to revoke its Grove access immediately.</li>
        </ul>
        <label className={styles.field} htmlFor="device-name">Name this browser</label>
        <input id="device-name" className={styles.input} value={name} maxLength={60} onChange={(e) => setTypedName(e.target.value)} disabled={phase === "pairing" || phase === "checking"} autoComplete="off" />
        {phase === "error" || message ? <p className={styles.error} role="alert">{message}</p> : null}
        <div className={styles.actions}>
          <button className="button primary large" type="button" onClick={connect} disabled={phase === "checking" || phase === "pairing" || !name.trim()}>{phase === "pairing" ? "Connecting…" : phase === "checking" ? "Looking for the extension…" : "Connect browser"}</button>
          <AppLink className="button ghost large" href="/settings#extension">Cancel</AppLink>
        </div>
      </>}
    </section>
  </main>;
}
