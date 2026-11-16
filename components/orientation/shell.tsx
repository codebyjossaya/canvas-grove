"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { GroveMark, Icon } from "@/components/ui/icons";
import { ORIENTATION_STEPS, STEP_COUNT } from "./model";
import styles from "./orientation.module.css";

type Direction = "forward" | "backward";
const StepContext = createContext(0);

/**
 * Page frame: brand bar, the step list (a rail on wide screens, a segmented bar on narrow ones)
 * and one content column. Completed steps are buttons; future steps are not reachable.
 * `focusOnChange` is off in the fixture gallery so a page of frames does not steal focus.
 */
export function OrientationShell({ step, reachable, complete, onNavigate, direction = "forward", focusOnChange = true, children }: {
  step: number;
  /** Highest step index the user may jump to. */
  reachable: number;
  /** Per-step "gate satisfied" flags, for the check marks. */
  complete: readonly boolean[];
  onNavigate?: (index: number) => void;
  direction?: Direction;
  focusOnChange?: boolean;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const firstRender = useRef(true);

  // Focus moves to the step heading on every step change (not on first load, which keeps the
  // browser's own focus order for people arriving from the sign-in page).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (focusOnChange) frame.current?.querySelector<HTMLHeadingElement>("h1")?.focus({ preventScroll: false });
  }, [step, focusOnChange]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const enabled = ORIENTATION_STEPS.map((_, i) => i).filter((i) => i <= reachable);
    const position = enabled.indexOf(index);
    let next: number | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = enabled[Math.min(position + 1, enabled.length - 1)];
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = enabled[Math.max(position - 1, 0)];
    if (event.key === "Home") next = enabled[0];
    if (event.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    buttons.current[next]?.focus();
  }

  return <div className={styles.root}>
    <header className={styles.bar}>
      <span className={styles.brand}><GroveMark /><span>Canvas Grove</span></span>
    </header>
    <div className={styles.layout}>
      <nav className={styles.rail} aria-label="Orientation steps">
        <p className={styles.railTitle}>Setup</p>
        <ol className={styles.steps}>
          {ORIENTATION_STEPS.map((entry, index) => {
            const current = index === step;
            const done = !current && complete[index] && index <= reachable;
            const state = current ? "current" : done ? "done" : index <= reachable ? "open" : "future";
            return <li key={entry.id}>
              <button
                ref={(node) => { buttons.current[index] = node; }}
                type="button"
                className={styles.stepButton}
                data-state={state}
                tabIndex={current ? 0 : -1}
                aria-current={current ? "step" : undefined}
                disabled={index > reachable}
                onClick={() => { if (!current) onNavigate?.(index); }}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <span className={styles.marker} aria-hidden="true">{done ? <Icon name="check" /> : index + 1}</span>
                <span className={styles.stepLabel}>{entry.label}<span className="sr-only">{"optional" in entry && entry.optional ? ", optional" : ""}{current ? ", current step" : done ? ", done" : index > reachable ? ", not yet available" : ""}</span></span>
              </button>
            </li>;
          })}
        </ol>
      </nav>
      <main className={styles.main}>
        <StepContext.Provider value={step}>
          <div ref={frame} key={step} className={styles.stepFrame} data-direction={direction}>{children}</div>
        </StepContext.Provider>
      </main>
    </div>
  </div>;
}

/** "Step 3 of 7 · Install extension", the step title (focus target) and one lead paragraph. */
export function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  const step = useContext(StepContext);
  const entry = ORIENTATION_STEPS[step];
  return <header className={styles.stepHead}>
    <p className={styles.status}>Step {step + 1} of {STEP_COUNT} · {entry?.label}{entry && "optional" in entry && entry.optional ? " (optional)" : ""}</p>
    <h1 className={styles.title} tabIndex={-1}>{title}</h1>
    {children ? <p className={styles.lead}>{children}</p> : null}
  </header>;
}

export type FooterAction = { label: string; onClick: () => void; disabled?: boolean; busy?: boolean; busyLabel?: string; icon?: string };

/**
 * Back on the left, the outcome button on the right. When the step's real action lives in the
 * body (download, connect, sign in), the footer button stays quiet until its gate is met, so a
 * view never shows two primary buttons. `helper` explains why it is disabled.
 */
export function StepFooter({ onBack, primary, quiet = false, helper, secondary }: { onBack?: () => void; primary?: FooterAction; quiet?: boolean; helper?: ReactNode; secondary?: FooterAction }) {
  const helperId = useId();
  return <footer className={styles.footer}>
    {onBack ? <button type="button" className={`button ghost large ${styles.back}`} onClick={onBack}><Icon name="arrow-left" />Back</button> : null}
    <div className={styles.footerEnd}>
      {helper ? <p id={helperId} className={styles.helper}>{helper}</p> : null}
      {secondary ? <button type="button" className="button secondary large" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</button> : null}
      {primary ? <button
        type="button"
        className={`button ${quiet || primary.disabled ? "secondary" : "primary"} large`}
        disabled={primary.disabled || primary.busy}
        aria-busy={primary.busy || undefined}
        aria-describedby={helper ? helperId : undefined}
        onClick={primary.onClick}
      >{primary.busy ? primary.busyLabel ?? primary.label : primary.label}{primary.icon && !primary.busy ? <Icon name={primary.icon} /> : null}</button> : null}
    </div>
  </footer>;
}

type Tone = "danger" | "warning" | "success" | "info";

/** Inline message next to the thing it is about. Errors say what happened, one fix, and retry. */
export function Callout({ tone, title, children, action, role }: { tone: Tone; title: string; children?: ReactNode; action?: ReactNode; role?: "alert" | "status" }) {
  return <div className={styles.callout} data-tone={tone} role={role ?? (tone === "danger" ? "alert" : "status")}>
    <p className={styles.calloutTitle}>{title}</p>
    {children ? <div className={styles.calloutBody}>{children}</div> : null}
    {action ? <div className={styles.calloutActions}>{action}</div> : null}
  </div>;
}

/** One concrete success line, e.g. "Signed in as Jane Doe on ufl.instructure.com". */
export function SuccessLine({ children }: { children: ReactNode }) {
  return <p className={styles.success} role="status"><Icon name="check-circle" /><span>{children}</span></p>;
}

/** Calm "we are watching for X" indicator. The dot breathes; reduced motion keeps it still. */
export function Watching({ children }: { children: ReactNode }) {
  return <p className={styles.watching} role="status"><span className={styles.pulse} aria-hidden="true" /><span>{children}</span></p>;
}

/** Monospace technical value (hosts, URLs, browser pages). */
export function Mono({ children }: { children: ReactNode }) {
  return <code className={styles.mono}>{children}</code>;
}

/**
 * True once `afterMs` has passed since `key` became non-null (troubleshooting that would be
 * noise in the first seconds). A new key restarts the clock; null means inactive.
 */
export function useElapsed(key: string | null, afterMs: number): boolean {
  const [firedFor, setFiredFor] = useState<string | null>(null);
  useEffect(() => {
    if (key === null || afterMs <= 0) return;
    const timer = window.setTimeout(() => setFiredFor(key), afterMs);
    return () => window.clearTimeout(timer);
  }, [key, afterMs]);
  return key !== null && (afterMs <= 0 || firedFor === key);
}
