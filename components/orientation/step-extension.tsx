"use client";

import { useState } from "react";
import { toUiError, type UiError } from "@/components/ui/ui-errors";
import type { ExtensionView } from "./model";
import { CopyButton } from "@/components/workspace/connect-agent/copy-button";
import { Callout, Mono, StepFooter, StepHeader, SuccessLine, Watching, useElapsed } from "./shell";
import styles from "./orientation.module.css";

const FALLBACK_AFTER_MS = 20_000;

/**
 * Step 3. Detection is automatic (the extension announces itself and the page re-asks on focus and
 * every 1.5 s), so there is no "Check again" button. Pairing happens here, inline, with one button.
 */
export function StepExtension({ ext, downloadUrl, minVersion, extensionsPage, defaultBrowserName, onPair, onReload, onBack, onNext, fallbackAfterMs = FALLBACK_AFTER_MS, initialPairError = null }: {
  ext: ExtensionView;
  downloadUrl: string;
  minVersion: string;
  extensionsPage: string;
  defaultBrowserName: string;
  onPair: (browserName: string) => Promise<void>;
  onReload: () => void;
  onBack: () => void;
  onNext: () => void;
  fallbackAfterMs?: number;
  /** Fixture preview only. */
  initialPairError?: UiError | null;
}) {
  const [typedName, setTypedName] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<UiError | null>(initialPairError);
  const name = (typedName ?? defaultBrowserName).slice(0, 60);
  const waiting = ext.status === "missing" || ext.status === "outdated";
  const showFallback = useElapsed(waiting ? ext.status : null, fallbackAfterMs);
  const fileName = downloadUrl.split("/").pop() ?? "the zip file";

  async function pair() {
    if (pairing || !name.trim()) return;
    setPairing(true); setPairError(null);
    try { await onPair(name.trim()); } catch (caught) { setPairError(normalizeError(caught)); } finally { setPairing(false); }
  }

  const footer = <StepFooter
    onBack={onBack}
    primary={{ label: "Continue", onClick: onNext, disabled: ext.status !== "ready", icon: "arrow" }}
    helper={ext.status === "ready" ? undefined : ext.status === "unpaired" ? "Connect this browser to continue." : ext.status === "checking" ? undefined : "Continue unlocks when Grove sees the extension."}
  />;

  if (ext.status === "ready") return <>
    <StepHeader title="The extension is ready">
      This browser can now hand your Canvas sign-in to Grove. Nothing else in your browser is shared.
    </StepHeader>
    <SuccessLine>Grove for Canvas {ext.version} is connected{ext.deviceName ? <> as <strong>{ext.deviceName}</strong></> : null}.</SuccessLine>
    <p className={styles.note}>You can rename or disconnect this browser later in Settings.</p>
    {footer}
  </>;

  if (ext.status === "unpaired") return <>
    <StepHeader title="Connect the extension to your account">
      Grove for Canvas {ext.version} is installed. Connect it so your Canvas sign-in is saved to this Grove account and no other.
    </StepHeader>
    <form className={styles.pairForm} onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="orientation-browser-name">Browser name</label>
        <input id="orientation-browser-name" className={styles.input} value={name} maxLength={60} autoComplete="off" required aria-describedby="orientation-browser-help" onChange={(event) => setTypedName(event.target.value)} />
        <p id="orientation-browser-help" className={styles.fieldHelp}>Shown in Settings, so you can tell your browsers apart and disconnect one.</p>
      </div>
      <div>
        <button type="submit" className="button primary large" disabled={pairing || !name.trim()} aria-busy={pairing || undefined}>{pairing ? "Connecting…" : "Connect this browser"}</button>
      </div>
      {pairError ? <Callout tone="danger" title={pairError.title}>
        <p>{pairError.message} {pairError.nextAction}</p>
      </Callout> : null}
    </form>
    {footer}
  </>;

  if (ext.status === "checking") return <>
    <StepHeader title="Install the Grove extension">
      Grove signs you in to Canvas through a small extension in this browser.
    </StepHeader>
    <Watching>Checking this browser for the Grove extension…</Watching>
    {footer}
  </>;

  const outdated = ext.status === "outdated";
  return <>
    <StepHeader title={outdated ? "Update the Grove extension" : "Install the Grove extension"}>
      {outdated
        ? <>This browser has Grove for Canvas {ext.version ?? "(an older version)"}. Sign-in needs version {minVersion} or newer.</>
        : <>Grove signs you in to Canvas through a small extension in this browser. It only reads the Canvas site you choose, and your password stays on your school&rsquo;s sign-in page.</>}
    </StepHeader>
    <ol className={styles.instructions}>
      <li>
        <span className={styles.instructionText}>Download Grove for Canvas {minVersion}.</span>
        <a className="button primary large" href={downloadUrl} download>Download extension</a>
        <span className={styles.fieldHelp}>A zip file, <Mono>{fileName}</Mono>.</span>
      </li>
      <li><span className={styles.instructionText}>Unzip it. Keep the folder somewhere it will stay, such as Documents.</span></li>
      <li>
        <span className={styles.instructionText}>Open <Mono>{extensionsPage}</Mono> in a new tab and turn on <strong>Developer mode</strong>.</span>
        <span><CopyButton text={extensionsPage} label="extensions page address" variant="secondary">Copy address</CopyButton></span>
      </li>
      <li><span className={styles.instructionText}>{outdated
        ? <>Remove the old Grove for Canvas, then choose <strong>Load unpacked</strong> and select the new folder.</>
        : <>Choose <strong>Load unpacked</strong> and select the unzipped folder.</>}</span></li>
    </ol>
    <Watching>Watching for {outdated ? `version ${minVersion}` : "the extension"} in this browser. This page updates by itself.</Watching>
    {showFallback ? <details className={styles.troubleshoot}>
      <summary>Still not detected?</summary>
      <ul>
        <li>In <Mono>{extensionsPage}</Mono>, check that Grove for Canvas is turned on and shows no errors.</li>
        <li>Make sure you selected the folder that contains <Mono>manifest.json</Mono>, not the zip file.</li>
        <li>Grove needs Chrome or Edge on a computer. Safari, Firefox and phones are not supported yet.</li>
        <li><button type="button" className={styles.inlineButton} onClick={onReload}>Reload this page</button>. Your progress is kept.</li>
      </ul>
    </details> : null}
    {footer}
  </>;
}

function normalizeError(caught: unknown): UiError {
  if (caught && typeof caught === "object" && "title" in caught && "message" in caught && "nextAction" in caught) return caught as UiError;
  const error = toUiError(caught);
  return error.code === "UNKNOWN"
    ? { ...error, title: "This browser was not connected", message: "Grove could not finish pairing with the extension. Nothing was saved.", nextAction: "Try again. If it keeps failing, reload this page." }
    : error;
}
