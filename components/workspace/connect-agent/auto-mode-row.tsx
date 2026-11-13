"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { autoActive, canEnable, capState, confirmationLines, DURATIONS, expiringSoon, type AutoTarget, type DurationMinutes } from "../approvals/auto-model";
import { CATEGORIES, DAILY_CAP, HOURLY_CAP, categoryLabel, formatRemaining } from "../approvals/model";
import { useNow } from "../approvals/use-now";
import type { AutoModeApi } from "./use-auto-mode";
import styles from "./connect-agent.module.css";

export type AutoPreview = { open?: boolean; categories?: string[]; confirm?: boolean };

/** Per-connection auto mode. Off by default, no categories preselected, explicit confirmation to enable. */
export function AutoModeRow({ target, api, preview }: { target: AutoTarget; api: AutoModeApi; preview?: AutoPreview }) {
  const now = useNow();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [setup, setSetup] = useState(preview?.open ?? false);
  const [categories, setCategories] = useState<string[]>(preview?.categories ?? []);
  const [minutes, setMinutes] = useState<DurationMinutes>(60);
  const [confirm, setConfirm] = useState(preview?.confirm ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { auto } = target;
  const active = autoActive(auto, now);
  const caps = capState(auto);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (confirm && !element.open) element.showModal();
    if (!confirm && element.open) element.close();
  }, [confirm]);

  async function run(change: { enabled: boolean; categories: string[]; durationMinutes: DurationMinutes }) {
    setBusy(true); setError("");
    const result = await api.save(target, change);
    setBusy(false);
    if (result.ok) { setConfirm(false); setSetup(false); setCategories([]); } else { setError(result.message); setConfirm(false); }
  }
  const toggle = (category: string) => setCategories(list => list.includes(category) ? list.filter(item => item !== category) : [...list, category]);

  if (!target.canPropose) return <div className={styles.autoRow}>
    <p className={styles.autoTitle}>Auto mode <span className="chip">Unavailable</span></p>
    <p className={styles.muted}>Read-only connection: reconnect with write permission to use actions.</p>
    <button type="button" className="button secondary" disabled>Set up auto mode</button>
  </div>;

  if (active) {
    const soon = expiringSoon(auto, now);
    return <div className={`${styles.autoRow} ${styles.autoOn}`}>
      <div className={styles.autoHead}>
        <p className={styles.autoTitle}>Auto mode <span className="chip warning">On</span>{soon ? <span className="chip danger">Ending soon</span> : null}</p>
        <button type="button" className={styles.killSwitch} disabled={busy} aria-busy={busy} onClick={() => void run({ enabled: false, categories: [], durationMinutes: null })}>Turn off</button>
      </div>
      <p className={styles.autoLine} suppressHydrationWarning>{auto.expiresAt ? `Expires in ${formatRemaining(new Date(auto.expiresAt).getTime() - now)}` : "Stays on until you turn it off"}</p>
      <p className={styles.autoLine}>Without asking: {auto.categories.map(categoryLabel).join(", ")}</p>
      <p className={styles.autoLine}>Used: {auto.usedLastHour} of {HOURLY_CAP} in the last hour, {auto.usedToday} of {DAILY_CAP} today</p>
      {caps.any ? <p className={styles.autoCap} role="status"><Icon name="alert" />{caps.hourly ? "Hourly" : "Daily"} cap reached: new actions wait for your approval until it resets.</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>;
  }

  return <div className={styles.autoRow}>
    <p className={styles.autoTitle}>Auto mode <span className="chip">Off</span></p>
    <p className={styles.muted}>Actions from this connection wait for your approval.</p>
    {!setup ? <button type="button" className="button secondary" onClick={() => setSetup(true)} aria-expanded={false}>Set up auto mode</button> : <fieldset className={styles.autoForm}>
      <legend className={styles.autoLegend}>Let it do these without asking</legend>
      {CATEGORIES.map(category => <label key={category.id} className={styles.checkRow}><input type="checkbox" className="cg-checkbox" checked={categories.includes(category.id)} onChange={() => toggle(category.id)} /><span>{category.label}</span></label>)}
      <label className={styles.autoDuration} htmlFor={`${id}-dur`}>For<select id={`${id}-dur`} value={minutes === null ? "null" : String(minutes)} onChange={event => setMinutes(event.target.value === "null" ? null : (Number(event.target.value) as DurationMinutes))}>{DURATIONS.map(duration => <option key={duration.label} value={duration.minutes === null ? "null" : String(duration.minutes)}>{duration.label}</option>)}</select></label>
      <div className={styles.autoButtons}>
        <button type="button" className="button primary" disabled={!canEnable(categories)} onClick={() => setConfirm(true)}>Review and turn on</button>
        <button type="button" className="button ghost" onClick={() => { setSetup(false); setCategories([]); }}>Cancel</button>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </fieldset>}
    <dialog ref={dialog} className={`${styles.confirm} cg-pop`} aria-labelledby={`${id}-ct`} onClose={() => setConfirm(false)}>
      <div className={styles.confirmInner}>
        <h3 id={`${id}-ct`} className={styles.sectionTitle}>Turn on auto mode for {target.name}?</h3>
        {(() => { const lines = confirmationLines(target.name, categories, minutes); return <>
          <p>{lines.intro}</p>
          <ul>{lines.does.map(line => <li key={line}>{line}</li>)}</ul>
          <ul className={styles.muted}>{lines.limits.map(line => <li key={line}>{line}</li>)}</ul>
        </>; })()}
        <div className={styles.autoButtons}>
          <button type="button" className="button primary" disabled={busy} aria-busy={busy} onClick={() => void run({ enabled: true, categories, durationMinutes: minutes })}>Turn on auto mode</button>
          <button type="button" className="button secondary" autoFocus onClick={() => setConfirm(false)}>Keep asking me</button>
        </div>
      </div>
    </dialog>
  </div>;
}
