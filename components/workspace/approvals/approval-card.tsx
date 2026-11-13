"use client";

import { Icon } from "@/components/ui/icons";
import { badgeFor, categoryLabel, consequenceFor, statusText, timeLeft, type ApprovalAction } from "./model";
import { useNow } from "./use-now";
import styles from "./approvals.module.css";

const dateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

function Preview({ action }: { action: ApprovalAction }) {
  return <>
    <dl className={styles.preview}>{action.preview.lines.map((line, index) => <div key={index}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
    {action.preview.warning ? <p className={styles.warning} role="note"><Icon name="alert" /><span>{action.preview.warning}</span></p> : null}
  </>;
}

/** An action waiting for a decision. Focusable so A / R / J / K work on it. */
export function AwaitingCard({ action, onDecide, error }: { action: ApprovalAction; onDecide: (action: ApprovalAction, decision: "approve" | "reject") => void; error?: string }) {
  const now = useNow();
  const left = timeLeft(action.expiresAt, now);
  const quiz = action.category === "quiz_entry";
  const titleId = `act-${action.id}-t`;
  return <article className={styles.card} tabIndex={0} data-approval-card data-id={action.id} aria-labelledby={titleId}>
    <header className={styles.cardHead}>
      <span className={styles.assistant}>{action.client.name}</span>
      <span className="chip">{categoryLabel(action.category)}</span>
      <span className={`${styles.timeLeft} ${left.urgent || left.expired ? styles.urgent : ""}`} suppressHydrationWarning><Icon name="clock" />{left.label}</span>
    </header>
    <h3 id={titleId} className={styles.cardTitle}>{action.title}</h3>
    <p className={quiz ? styles.consequenceQuiz : styles.consequence}>{consequenceFor(action)}</p>
    <Preview action={action} />
    {error ? <p className={styles.cardError} role="alert">{error}</p> : null}
    <footer className={styles.cardActions}>
      <button type="button" className="button primary" disabled={left.expired} onClick={() => onDecide(action, "approve")} aria-keyshortcuts="A">Approve <kbd className="kbd" aria-hidden="true">A</kbd></button>
      <button type="button" className="button secondary" onClick={() => onDecide(action, "reject")} aria-keyshortcuts="R">Reject <kbd className="kbd" aria-hidden="true">R</kbd></button>
      {left.expired ? <span className={styles.muted}>Expired. Reject to clear it.</span> : null}
    </footer>
  </article>;
}

/** A decided action in the history list. */
export function HistoryCard({ action }: { action: ApprovalAction }) {
  const badge = badgeFor(action);
  const decided = action.decidedAt ? dateTime.format(new Date(action.decidedAt)) : null;
  return <article className={styles.card} tabIndex={0} data-approval-card data-id={action.id} aria-label={`${action.title}, ${statusText(action.status)}`}>
    <header className={styles.cardHead}>
      <span className={styles.assistant}>{action.client.name}</span>
      <span className={`chip ${badge.tone === "auto" ? "accent" : badge.tone === "you" ? "info" : ""}`}>{badge.text}</span>
      <span className={`chip ${action.status === "done" ? "success" : action.status === "failed" ? "danger" : ""}`}>{statusText(action.status)}</span>
      {decided ? <span className={styles.timeLeft} suppressHydrationWarning>{decided} UTC</span> : null}
    </header>
    <h3 className={styles.cardTitle}>{action.title}</h3>
    {action.result ? <p className={action.result.ok ? styles.resultOk : styles.cardError}>{action.result.message}</p> : null}
    <details className={styles.more}><summary>What was proposed</summary><Preview action={action} /></details>
  </article>;
}
