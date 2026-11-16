"use client";

import type { ReactNode } from "react";
import type { UiError } from "@/components/ui/ui-errors";
import { ORIENTATION_STEPS, stepIndex, type StepId } from "./model";
import { Callout, StepFooter, StepHeader } from "./shell";
import styles from "./orientation.module.css";

export type SummaryRow = { step: StepId; label: string; value: ReactNode; pending?: boolean };

/** Step 7. A plain summary of what was set up, each row editable. Finishing is re-checked by the server. */
export function StepDone({ rows, finishing, error, missing, onGoTo, onFinish, onBack }: {
  rows: SummaryRow[];
  finishing: boolean;
  error: UiError | null;
  /** Steps the server says are not done yet (409 ORIENTATION_INCOMPLETE). */
  missing: StepId[];
  onGoTo: (step: StepId) => void;
  onFinish: () => void;
  onBack: () => void;
}) {
  return <>
    <StepHeader title={missing.length ? "Almost done" : "You are all set"}>
      {missing.length
        ? "Grove checked your setup, and some required steps are not finished. Everything else is saved."
        : "Grove starts syncing from Canvas now. Your courses appear first; the rest fills in over a few minutes."}
    </StepHeader>
    <dl className={styles.summary}>
      {rows.map((row) => <div key={row.label} className={styles.summaryRow}>
        <dt>{row.label}</dt>
        <dd data-pending={row.pending || undefined}>{row.value}</dd>
        <dd className={styles.summaryEdit}><button type="button" className={styles.inlineButton} onClick={() => onGoTo(row.step)}>Change<span className="sr-only"> {row.label.toLowerCase()}</span></button></dd>
      </div>)}
    </dl>
    {missing.length ? <Callout tone="warning" title={missing.length === 1 ? "This step still needs you" : "These steps still need you"} action={<>{missing.map((step) => <button key={step} type="button" className="button secondary" onClick={() => onGoTo(step)}>Go to {ORIENTATION_STEPS[stepIndex(step)].label}</button>)}</>}>
    </Callout> : error ? <Callout tone="danger" title={error.title} action={<button type="button" className="button secondary" onClick={onFinish}>Try again</button>}>
      <p>{error.message} {error.nextAction}</p>
    </Callout> : null}
    <StepFooter onBack={onBack} primary={{ label: "Open Canvas Grove", onClick: onFinish, busy: finishing, busyLabel: "Opening…", icon: "arrow" }} />
  </>;
}
