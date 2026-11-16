"use client";

import { hostOf, type School, type SignInView } from "./model";
import { Callout, Mono, StepFooter, StepHeader, SuccessLine, Watching, useElapsed } from "./shell";
import styles from "./orientation.module.css";

const FALLBACK_AFTER_MS = 20_000;

/**
 * Step 5. Grove asks the extension to open a sign-in tab; the extension watches that tab and closes
 * it once Canvas recognises the user. Completion is the server's call (the hook polls it).
 */
export function StepSignIn({ view, school, onStart, onFocusTab, onCancel, onRetry, onBack, onNext, fallbackAfterMs = FALLBACK_AFTER_MS }: {
  view: SignInView;
  school: School | null;
  onStart: () => void;
  onFocusTab: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onBack: () => void;
  onNext: () => void;
  fallbackAfterMs?: number;
}) {
  const schoolName = school?.name ?? "your school";
  const host = hostOf(view.canvasOrigin ?? view.existing?.canvasOrigin ?? school?.domain) || "your Canvas site";
  const short = shortSchoolName(schoolName);
  const canvasName = short ? `${short} Canvas` : "Canvas";
  const waitingKey = view.phase === "awaiting-tab-click" || view.phase === "signing-in" ? "waiting" : null;
  const showFallback = useElapsed(waitingKey, fallbackAfterMs);
  const connected = view.phase === "connected" || (view.phase === "idle" && Boolean(view.existing?.connected));
  const accountName = view.accountName ?? view.existing?.accountName ?? null;

  const footer = <StepFooter
    onBack={onBack}
    primary={{ label: "Continue", onClick: onNext, disabled: !connected, icon: "arrow" }}
    helper={connected ? undefined : view.phase === "idle" || view.phase === "error" ? "Sign in to Canvas to continue." : "Continue unlocks when Canvas confirms your sign-in."}
  />;

  if (connected) return <>
    <StepHeader title="Canvas is connected">
      Grove can now sync the areas you allowed. You stay signed in until you disconnect in Settings or {schoolName} ends the session.
    </StepHeader>
    <SuccessLine>Signed in{accountName ? <> as <strong>{accountName}</strong></> : null} on <Mono>{host}</Mono>.</SuccessLine>
    {view.phase === "idle" ? <p className={styles.note}>Signed in to the wrong account? <button type="button" className={styles.inlineButton} onClick={onStart}>Sign in again</button></p> : null}
    {footer}
  </>;

  if (view.phase === "idle" || view.phase === "starting") return <>
    <StepHeader title={`Sign in to ${canvasName}`}>
      A new tab opens on your school&rsquo;s own Canvas sign-in. Sign in the way you normally do, including MFA.
    </StepHeader>
    <dl className={styles.facts}>
      <div><dt>Canvas site</dt><dd><Mono>{host}</Mono></dd></div>
      <div><dt>What the extension reads</dt><dd>Your Canvas session for this site only, after you sign in.</dd></div>
      <div><dt>When it is done</dt><dd>The tab closes by itself and you come back here.</dd></div>
    </dl>
    <div>
      <button type="button" className="button primary large" onClick={onStart} disabled={view.phase === "starting"} aria-busy={view.phase === "starting" || undefined}>
        {view.phase === "starting" ? "Opening sign-in tab…" : `Continue to ${canvasName}`}
      </button>
    </div>
    {footer}
  </>;

  if (view.phase === "error") return <>
    <StepHeader title={`Sign in to ${canvasName}`}>
      The sign-in did not finish. Nothing was saved, and your earlier steps are kept.
    </StepHeader>
    <Callout tone="danger" title={view.error?.title ?? "Canvas sign-in did not finish"} action={<button type="button" className="button primary" onClick={onRetry}>Try again</button>}>
      <p>{view.error ? `${view.error.message} ${view.error.nextAction}` : "Start the sign-in again from here."}</p>
    </Callout>
    {footer}
  </>;

  if (view.tabClosed && view.phase !== "verifying") return <>
    <StepHeader title="The sign-in tab was closed">
      Canvas had not finished signing you in. Reopen the tab to pick up where you left off.
    </StepHeader>
    <div className={styles.actionsRow}>
      <button type="button" className="button primary large" onClick={onFocusTab}>Reopen sign-in tab</button>
      <button type="button" className="button ghost large" onClick={onCancel}>Cancel sign-in</button>
    </div>
    {footer}
  </>;

  // awaiting-tab-click, signing-in, verifying
  const verifying = view.phase === "verifying";
  const awaitingClick = view.phase === "awaiting-tab-click";
  return <>
    <StepHeader title={verifying ? "Checking your Canvas session" : "Continue in the new tab"}>
      {verifying
        ? <>Canvas recognised you. Grove is confirming the session with <Mono>{host}</Mono>.</>
        : awaitingClick
          ? <>In the tab that just opened, choose <strong>Continue to {canvasName}</strong>. Chrome may ask to let the extension read <Mono>{host}</Mono>.</>
          : <>Sign in on <Mono>{host}</Mono> in the tab that just opened. The side panel there shows your progress.</>}
    </StepHeader>
    <Watching>{verifying ? "Confirming with Canvas…" : "Watching for Canvas to recognise you. The sign-in tab closes by itself."}</Watching>
    {!verifying ? <div className={styles.actionsRow}>
      <button type="button" className="button secondary" onClick={onFocusTab}>Show sign-in tab</button>
      <button type="button" className="button ghost" onClick={onCancel}>Cancel sign-in</button>
    </div> : null}
    {showFallback && !verifying ? <details className={styles.troubleshoot}>
      <summary>Not seeing the tab?</summary>
      <ul>
        <li>Look for a new Grove tab right next to this one. <button type="button" className={styles.inlineButton} onClick={onFocusTab}>Show it</button> reopens it if you closed it.</li>
        <li>If Chrome asked for permission to read <Mono>{host}</Mono> and you closed the prompt, show the tab and choose Continue again.</li>
        <li>Finished signing in but still waiting? Open any Canvas page in that tab; Grove checks again as it loads.</li>
        <li><button type="button" className={styles.inlineButton} onClick={onCancel}>Cancel</button> and start over. Your earlier steps are kept.</li>
      </ul>
    </details> : null}
    {footer}
  </>;
}

/** Very long school names are dropped from button labels ("Continue to Canvas"). */
function shortSchoolName(name: string): string | null {
  return name && name !== "your school" && name.length <= 32 ? name : null;
}
