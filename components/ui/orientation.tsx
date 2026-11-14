"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EXTENSION_INSTALL_PATH } from "@/lib/extension/links";
import { ErrorNotice } from "./error-notice";
import { GroveMark, Icon } from "./icons";
import { toUiError, type UiError } from "./ui-errors";

export const ORIENTATION_STEPS = [
  { eyebrow: "Welcome", icon: "today", title: "A calmer view of Canvas.", body: "Canvas Grove gathers your courses, deadlines, and messages into one focused workspace. It complements Canvas; your school remains the source of truth.", note: "See what matters now, without hunting through tabs." },
  { eyebrow: "Privacy", icon: "lock", title: "A browser session you control.", body: "To reach Canvas, an isolated browser runs on this service operator’s machine. Its temporary live view is for you to enter your institution credentials and approve multi-factor authentication—the agent does not ask for or receive them.", note: "You can revoke and delete the session from Settings." },
  { eyebrow: "Connect", icon: "wifi", title: "You complete your institution sign-in.", body: "Canvas Grove opens the secure live browser at your institution’s Canvas address. Check the origin, sign in yourself, and complete any verification prompt. Connection verification happens automatically.", note: "There is no password field inside Canvas Grove." },
  { eyebrow: "Freshness", icon: "refresh", title: "Updates continue in the background.", body: "Once connected, scheduled sync can refresh supported Canvas information while this app is closed. Freshness labels show the last successful sync, and offline or expired sessions are called out clearly.", note: "Canvas availability and the operator host can affect timing." },
  { eyebrow: "Browser extension", icon: "external", title: "Open Canvas-only work in this browser.", body: "The optional Grove for Canvas browser extension is needed when Canvas must launch an external tool, such as Pearson MyLab, Gradescope, MATLAB, or New Quizzes. Regular Grove pages and synced course data work without it.", note: "It is limited to Grove and your Canvas site—not other sites, your institution password, or identity-provider cookies. Download the latest release, unzip it, load the folder in Chrome or Edge, and revoke it from Settings anytime.", installHref: EXTENSION_INSTALL_PATH },
  { eyebrow: "Ready", icon: "check-circle", title: "Make the grove yours.", body: "Connect Canvas now to begin syncing, or enter the dashboard first. You can replay this orientation and manage the browser session any time in Settings.", note: "Nothing connects until you explicitly start it." },
] as const;

type StepDirection = "forward" | "backward";

export function Orientation() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<StepDirection>("forward");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const progressButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const item = ORIENTATION_STEPS[step];
  const last = step === ORIENTATION_STEPS.length - 1;

  useEffect(() => heading.current?.focus({ preventScroll: true }), [step]);

  function goTo(next: number) {
    const bounded = Math.max(0, Math.min(ORIENTATION_STEPS.length - 1, next));
    if (bounded === step) return;
    setDirection(bounded > step ? "forward" : "backward");
    setStep(bounded);
    setError(null);
  }

  function onProgressKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(index + 1, ORIENTATION_STEPS.length - 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(index - 1, 0);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = ORIENTATION_STEPS.length - 1;
    if (next === null) return;
    event.preventDefault();
    progressButtons.current[next]?.focus();
  }

  async function finish(destination: string) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: true }) });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || "Your orientation choice could not be saved.");
      }
      router.push(destination);
      router.refresh();
    } catch (caught) {
      setError(toUiError(caught, !navigator.onLine ? "NETWORK_OFFLINE" : "SERVER_UNAVAILABLE"));
      setSaving(false);
    }
  }

  return <main className="orientation">
    <header className="orientation-bar">
      <Link className="brand" href="/"><GroveMark /><span>Canvas Grove</span></Link>
      <button type="button" className="orientation-skip" disabled={saving} onClick={() => void finish("/")}>Skip for now</button>
    </header>
    <section className="orientation-frame" aria-labelledby="orientation-title">
      <aside key={`visual-${step}`} className="orientation-visual" data-direction={direction}>
        <div className="orientation-visual-head">
          <span className="orientation-number" aria-hidden="true">{String(step + 1).padStart(2, "0")}</span>
          <span className="orientation-step-icon" aria-hidden="true"><Icon name={item.icon} /></span>
        </div>
        <div className="orientation-orbit" aria-hidden="true"><i /><i /><i /><span><GroveMark /></span></div>
        <div className="orientation-note">
          <span className="orientation-note-kicker">Good to know</span>
          <p>{item.note}</p>
        </div>
      </aside>
      <div className="orientation-copy">
        <nav className="orientation-progress" aria-label="Orientation steps">
          <div className="orientation-progress-label"><span>Orientation</span><strong aria-live="polite">{step + 1} <i aria-hidden="true">/</i> {ORIENTATION_STEPS.length}</strong></div>
          <ol>{ORIENTATION_STEPS.map((entry, index) => <li key={entry.eyebrow}>
            <button
              ref={node => { progressButtons.current[index] = node; }}
              type="button"
              className={index < step ? "complete" : ""}
              tabIndex={index === step ? 0 : -1}
              aria-current={index === step ? "step" : undefined}
              aria-label={`${index < step ? "Completed" : index === step ? "Current" : "Go to"} step ${index + 1}: ${entry.eyebrow}`}
              disabled={saving}
              onClick={() => goTo(index)}
              onKeyDown={event => onProgressKeyDown(event, index)}
            ><span aria-hidden="true">{index < step ? <Icon name="check" /> : index + 1}</span><em>{entry.eyebrow}</em></button>
          </li>)}</ol>
        </nav>
        <div key={`copy-${step}`} className="orientation-step" data-direction={direction}>
          <p className="eyebrow">{item.eyebrow}</p>
          <h1 id="orientation-title" ref={heading} tabIndex={-1}>{item.title}</h1>
          <p className="orientation-body">{item.body}</p>
          {"installHref" in item && <Link className="orientation-inline-link" href={item.installHref}><span>Install or connect the extension</span><Icon name="arrow" /></Link>}
        </div>
        {error && <ErrorNotice error={error} onRetry={() => void finish(last ? "/settings" : "/")} />}
        <div className="orientation-actions">
          <button type="button" className="button secondary large" disabled={step === 0 || saving} onClick={() => goTo(step - 1)}><Icon name="arrow-left" />Back</button>
          {!last
            ? <button type="button" className="button primary large" disabled={saving} onClick={() => goTo(step + 1)}>Continue <Icon name="arrow" /></button>
            : <div className="orientation-finish"><button type="button" className="button primary large" disabled={saving} aria-busy={saving} onClick={() => void finish("/settings")}>{saving ? "Saving…" : "Connect Canvas"}</button><button type="button" className="button ghost large" disabled={saving} onClick={() => void finish("/")}>Enter dashboard</button></div>}
        </div>
      </div>
    </section>
  </main>;
}
