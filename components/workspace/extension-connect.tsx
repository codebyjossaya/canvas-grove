"use client";

/**
 * /extension/connect: install, update or pair Grove for Canvas in this browser. Detection is live
 * (useExtension re-asks the extension every 1.5 s and on focus), so there is no "Check again" button.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppLink } from "@/components/ui/app-link";
import { ErrorNotice } from "@/components/ui/error-notice";
import { GroveMark } from "@/components/ui/icons";
import type { UiError } from "@/components/ui/ui-errors";
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension/links";
import { MIN_EXTENSION_VERSION, useExtension } from "@/lib/extension/use-extension";
import styles from "./extension.module.css";

function guessDeviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
function extensionsPage() {
  return /Edg\//.test(navigator.userAgent) ? "edge://extensions" : "chrome://extensions";
}
const subscribeNever = () => () => undefined;

export function ExtensionConnect() {
  const extension = useExtension();
  const guessed = useSyncExternalStore(subscribeNever, guessDeviceName, () => "");
  const extensionsUrl = useSyncExternalStore(subscribeNever, extensionsPage, () => "chrome://extensions");
  const [typedName, setTypedName] = useState<string | null>(null);
  const name = (typedName ?? guessed).slice(0, 60);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const status = extension.status;

  // Move focus to the new heading when detection changes what this page asks for.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [status]);

  async function connect() {
    setPairing(true); setError(null);
    try { await extension.pair(name.trim()); }
    catch (value) { setError(value as UiError); }
    finally { setPairing(false); }
  }

  return <main className={`page ${styles.page}`}>
    <section className={styles.card} aria-labelledby="connect-title">
      <div className={styles.brand}><GroveMark /><span>Grove for Canvas</span></div>

      {status === "checking" ? <>
        <h1 id="connect-title" ref={heading} tabIndex={-1}>Connect this browser</h1>
        <p className={styles.waitLine} role="status"><span className={styles.pulse} aria-hidden="true" />Looking for the Grove extension in this browser…</p>
      </> : status === "missing" || status === "outdated" ? <>
        <h1 id="connect-title" ref={heading} tabIndex={-1}>{status === "outdated" ? "Update Grove for Canvas" : "Install Grove for Canvas"}</h1>
        <p className={styles.lede}>{status === "outdated"
          ? `This browser has an older version of the extension. Canvas sign-in needs version ${MIN_EXTENSION_VERSION} or newer.`
          : "Grove signs you in to Canvas inside this browser, through its extension. It is not in the Chrome Web Store yet, so it installs from a file."}</p>
        <ol className={styles.steps}>
          <li><span>Download the extension and unzip it.</span></li>
          <li><span>Open <code className={styles.mono}>{extensionsUrl}</code> in a new tab and turn on Developer mode.</span></li>
          <li><span>{status === "outdated" ? "Remove the old Grove for Canvas, then select Load unpacked and choose the new folder." : "Select Load unpacked and choose the unzipped folder."}</span></li>
        </ol>
        <div className={styles.actions}>
          <a className="button primary large" href={EXTENSION_DOWNLOAD_URL} download>Download the extension</a>
          <AppLink className="button ghost large" href="/settings#extension">Cancel</AppLink>
        </div>
        <p className={styles.waitLine} role="status"><span className={styles.pulse} aria-hidden="true" />{status === "outdated" ? "Waiting for the new version. This page updates by itself." : "Waiting for the extension. This page updates by itself once it is installed."}</p>
      </> : status === "ready" ? <>
        <h1 id="connect-title" ref={heading} tabIndex={-1}>This browser is connected</h1>
        <p className={styles.success} role="status">{extension.state?.deviceName ? `Connected as ${extension.state.deviceName}.` : "Connected to your Grove account."}</p>
        <p className={styles.lede}>Next, sign in to Canvas. The extension opens your school&apos;s Canvas in a new tab and closes it once you are signed in.</p>
        <div className={styles.actions}>
          <AppLink className="button primary large" href="/settings#connection">Sign in to Canvas</AppLink>
          <AppLink className="button ghost large" href="/settings#extension">Manage browsers</AppLink>
        </div>
      </> : <>
        <h1 id="connect-title" ref={heading} tabIndex={-1}>Connect this browser</h1>
        <p className={styles.lede}>The extension is installed. Connect it to your Grove account so it can finish Canvas sign-in here.</p>
        <dl className={styles.facts}>
          <div><dt>Can</dt><dd>Read the Canvas session for the one Canvas site you approve, and send it to Grove over an encrypted connection.</dd></div>
          <div><dt>Cannot</dt><dd>See your school password, multi-factor codes, identity-provider cookies or any other site.</dd></div>
          <div><dt>Undo</dt><dd>Disconnect this browser in Settings at any time. Its access ends immediately.</dd></div>
        </dl>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (name.trim() && !pairing) void connect(); }}>
          <label className={styles.field} htmlFor="device-name">Browser name</label>
          <input id="device-name" className={styles.input} value={name} maxLength={60} onChange={(e) => setTypedName(e.target.value)} disabled={pairing} autoComplete="off" aria-describedby="device-name-help" />
          <small id="device-name-help" className={styles.helper}>Shown in Settings so you can tell your browsers apart.</small>
          {error ? <ErrorNotice error={error} /> : null}
          <div className={styles.actions}>
            <button className="button primary large" disabled={pairing || !name.trim()} aria-busy={pairing}>{pairing ? "Connecting…" : "Connect this browser"}</button>
            <AppLink className="button ghost large" href="/settings#extension">Cancel</AppLink>
          </div>
          {!name.trim() ? <small className={styles.helper}>Enter a name to continue.</small> : null}
        </form>
      </>}
    </section>
  </main>;
}
