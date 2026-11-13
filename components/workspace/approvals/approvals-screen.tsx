"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { AwaitingCard, HistoryCard } from "./approval-card";
import { moveIndex, type ApprovalAction } from "./model";
import { useActions, type ActionsFixture } from "./use-actions";
import styles from "./approvals.module.css";

export type ApprovalsFixture = { awaiting?: ActionsFixture; history?: ActionsFixture };
type Tab = "awaiting" | "history";

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
}

function Panel({ tab, onTab, fixture }: { tab: Tab; onTab: (tab: Tab) => void; fixture?: ActionsFixture }) {
  const { state, reload, decide, notices, dismiss, errors } = useActions(tab, fixture);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const cards = useCallback(() => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-card]") ?? []), []);

  const handleDecide = useCallback((action: ApprovalAction, decision: "approve" | "reject") => {
    const list = cards();
    const index = list.findIndex(element => element.dataset.id === action.id);
    const next = list[index + 1] ?? list[index - 1] ?? null;
    void decide(action, decision);
    requestAnimationFrame(() => (next && next.isConnected ? next : headingRef.current)?.focus());
  }, [cards, decide]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const list = cards();
      const current = list.findIndex(element => element === document.activeElement || element.contains(document.activeElement));
      if (key === "j" || key === "k") {
        const next = moveIndex(current, key === "j" ? 1 : -1, list.length);
        if (next >= 0 && next !== current) { event.preventDefault(); list[next].focus(); list[next].scrollIntoView({ block: "nearest" }); }
        return;
      }
      if (tab !== "awaiting" || current < 0 || (key !== "a" && key !== "r")) return;
      if ((event.target as HTMLElement).tagName === "BUTTON" && event.repeat) return;
      const action = state.actions.find(item => item.id === list[current].dataset.id);
      if (!action) return;
      event.preventDefault();
      handleDecide(action, key === "a" ? "approve" : "reject");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cards, handleDecide, state.actions, tab]);

  const empty = state.status === "ready" && state.actions.length === 0;
  return <>
    <div className={styles.tabs} role="tablist" aria-label="Approvals">
      <button type="button" role="tab" id="tab-awaiting" aria-selected={tab === "awaiting"} aria-controls="panel-approvals" onClick={() => onTab("awaiting")}>Awaiting{state.awaitingCount > 0 ? <span className={styles.count} aria-label={`${state.awaitingCount} waiting`}>{state.awaitingCount}</span> : null}</button>
      <button type="button" role="tab" id="tab-history" aria-selected={tab === "history"} aria-controls="panel-approvals" onClick={() => onTab("history")}>History</button>
    </div>
    <div className={styles.notices} role="status" aria-live="polite">{notices.map(notice => <p key={notice.id} className={notice.tone === "error" ? styles.noticeError : styles.notice}><span>{notice.text}</span><button type="button" className={styles.linkButton} onClick={() => dismiss(notice.id)} aria-label="Dismiss message">Dismiss</button></p>)}</div>
    <div id="panel-approvals" role="tabpanel" aria-labelledby={`tab-${tab}`} ref={listRef} className={styles.list}>
      <h2 ref={headingRef} tabIndex={-1} className={styles.srOnly}>{tab === "awaiting" ? "Actions waiting for you" : "Decided actions"}</h2>
      {state.status === "loading" && state.actions.length === 0 ? <p className={styles.muted} role="status">Loading…</p> : null}
      {state.status === "error" ? <div className={styles.empty} role="alert"><Icon name="alert" /><p>Could not load your actions.</p><button type="button" className="button secondary" onClick={reload}>Try again</button></div> : null}
      {empty && tab === "awaiting" ? <div className={styles.empty}><Icon name="check-circle" /><p><strong>Nothing is waiting for you.</strong></p><p className={styles.muted}>When a connected assistant proposes an action, such as submitting an assignment, it appears here and nothing happens until you approve it.</p></div> : null}
      {empty && tab === "history" ? <div className={styles.empty}><Icon name="clock" /><p><strong>No decisions yet.</strong></p><p className={styles.muted}>Approved, rejected, automatic and expired actions are listed here.</p></div> : null}
      {state.actions.map(action => tab === "awaiting" ? <AwaitingCard key={action.id} action={action} onDecide={handleDecide} error={errors[action.id]} /> : <HistoryCard key={action.id} action={action} />)}
    </div>
    {state.actions.length > 0 ? <p className={styles.hint}><kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd> move{tab === "awaiting" ? <>, <kbd className="kbd">A</kbd> approve, <kbd className="kbd">R</kbd> reject the focused card</> : null}</p> : null}
  </>;
}

export function ApprovalsScreen({ fixture, initialTab = "awaiting" }: { fixture?: ApprovalsFixture; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return <main className={`page ${styles.page}`}>
    <header className="page-head"><div><h1>Approvals</h1><p>Actions your connected assistants have proposed. Nothing is sent to Canvas until you approve it, unless you turned on auto mode for that connection.</p></div></header>
    <Panel key={tab} tab={tab} onTab={setTab} fixture={fixture?.[tab]} />
  </main>;
}
