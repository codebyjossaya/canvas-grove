"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "./icons";
import { SlideIndicators } from "./slide-indicators";
import { ThemeControl } from "./theme-provider";
import styles from "./motion-preview.module.css";

const ROWS = Array.from({ length: 300 }, (_, index) => `Row ${index + 1} (no motion beyond an 80ms background fade)`);
const TABS = ["Overview", "Modules", "Grades"] as const;

/** Fixtures-only gallery for the motion layer. Everything here is local state. */
export function MotionPreview() {
  const params = useSearchParams();
  const theme = params.get("theme");
  // ?select=past|all (segmented), labs|readings (single-select chips), modules|grades (tabs) preselects a state.
  const pick = (params.get("select") ?? "").toLowerCase();
  const [seg, setSeg] = useState(pick === "past" ? "Past" : pick === "all" ? "All" : "Upcoming");
  const [one, setOne] = useState(pick === "labs" ? "Labs" : pick === "readings" ? "Readings" : "All");
  const [chips, setChips] = useState(new Set(["All"]));
  const [tab, setTab] = useState<(typeof TABS)[number]>(pick === "modules" ? "Modules" : pick === "grades" ? "Grades" : "Overview");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [round, setRound] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (theme === "dark" || theme === "light") { const root = document.documentElement; root.dataset.theme = theme; root.style.colorScheme = theme; }
  }, [theme]);
  useEffect(() => {
    const timer = window.setTimeout(() => setLoaded(true), 1200);
    return () => window.clearTimeout(timer);
  }, [round]);
  useEffect(() => {
    if (!auto) return;
    const order = ["Upcoming", "Past", "All"];
    const timer = window.setInterval(() => setSeg(value => order[(order.indexOf(value) + 1) % order.length]), 900);
    return () => window.clearInterval(timer);
  }, [auto]);
  const arrow = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    setTab(next);
    document.getElementById(`tab-${next.toLowerCase()}`)?.focus();
  };
  const replay = () => { setLoaded(false); setRound(value => value + 1); };
  const fakeBusy = () => { setBusy(true); window.setTimeout(() => setBusy(false), 1600); };

  return <main className={`${styles.page} cg-stagger`}>
    <SlideIndicators />
    <div className={styles.head}>
      <h1>Motion preview</h1>
      <span className={styles.row}><a className="button ghost" href="?theme=light">Light</a><a className="button ghost" href="?theme=dark">Dark</a><ThemeControl compact /></span>
    </div>

    <section className={styles.sec}><h2>Buttons</h2><div className={`${styles.row} ${styles.panel}`}>
      <button className="button primary">Primary</button>
      <button className="button secondary">Secondary</button>
      <button className="button ghost">Ghost</button>
      <button className="button primary large">Large <Icon name="chevron-right" /></button>
      <button className="button icon ghost" aria-label="Refresh"><Icon name="refresh" /></button>
      <button className="button primary" disabled>Disabled</button>
      <button className="button primary" aria-busy={busy || undefined} onClick={fakeBusy}><Icon name="refresh" />{busy ? "Syncing…" : "Sync now"}</button>
      <button className="danger-button">Remove</button>
      <a className="button secondary" href="#links">Link as button</a>
      <a className="inline-link" href="#links" id="links">Inline link</a>
      <span className="chip accent">Chip</span><span className="chip success">Synced</span>
    </div></section>

    <section className={styles.sec}><h2>Segmented control, filter chips, tabs</h2><div className={`${styles.panel} ${styles.sec}`}>
      <div className={styles.row}><div id="slide-seg" className={styles.segmented} role="group" aria-label="Filter">{["Upcoming", "Past", "All"].map(value => <button key={value} id={`seg-${value.toLowerCase()}`} aria-pressed={seg === value} onClick={() => setSeg(value)}>{value}</button>)}</div><button id="slide-autoplay" className="button secondary" aria-pressed={auto} onClick={() => setAuto(value => !value)}>{auto ? "Stop autoplay" : "Autoplay segmented"}</button></div>
      <div id="slide-chips" className={styles.chips} role="group" aria-label="Single-select chips">{["All", "Lectures", "Labs", "Readings"].map(value => <button key={value} id={`chip-${value.toLowerCase()}`} aria-pressed={one === value} onClick={() => setOne(value)}>{value}</button>)}</div>
      <div id="multi-chips" className={styles.chips} role="group" aria-label="Multi-select chips (no indicator)">{["All", "Lectures", "Labs", "Readings"].map(value => <button key={value} aria-pressed={chips.has(value)} onClick={() => setChips(prev => { const next = new Set(prev); if (!next.delete(value)) next.add(value); return next; })}>{value}</button>)}</div>
      <div id="slide-tabs" className={styles.tabs} role="tablist" onKeyDown={arrow}>{TABS.map(value => <button key={value} id={`tab-${value.toLowerCase()}`} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} onClick={() => setTab(value)}>{value}</button>)}</div>
    </div></section>

    <section className={styles.sec}><h2>Toggles</h2><div className={`${styles.row} ${styles.panel}`}>
      <label className={styles.label}><input type="checkbox" className="cg-switch" defaultChecked /> Switch</label>
      <label className={styles.label}><input type="checkbox" className="cg-switch" /> Switch off</label>
      <label className={styles.label}><input type="checkbox" className="cg-checkbox" defaultChecked /> Checkbox</label>
      <label className={styles.label}><input type="checkbox" className="cg-checkbox" /> Checkbox off</label>
    </div></section>

    <section className={styles.sec}><h2>Dialog and popover</h2><div className={`${styles.row} ${styles.panel}`}>
      <button className="button secondary" onClick={() => dialog.current?.showModal()}>Open dialog</button>
      <button className="button secondary" popoverTarget="motion-pop">Open popover</button>
      <div id="motion-pop" popover="auto" className={`cg-pop ${styles.pop}`}>A popover enters in 200ms and leaves in 100ms.</div>
      <dialog ref={dialog} className={`cg-pop ${styles.dialog}`}>
        <h3>Dialog</h3><p>Fade, small scale and translate on enter; quieter exit.</p>
        <div className={styles.row} style={{ marginTop: 16 }}><button className="button primary" onClick={() => dialog.current?.close()}>Done</button></div>
      </dialog>
    </div></section>

    <section className={styles.sec}><h2>Card grid (staggered fade-in)</h2><div className={`${styles.grid} cg-stagger`} key={`grid-${round}`}>
      {Array.from({ length: 8 }, (_, index) => <div className={styles.card} key={index}><strong>Card {index + 1}</strong><p>Fades in 20ms after the previous one.</p></div>)}
    </div></section>

    <section className={styles.sec}><h2>Skeleton to content <button className="button secondary" onClick={replay}>Replay</button></h2>
      <div className={`${styles.panel} ${styles.swap}`} key={`sk-${round}-${loaded}`}>{loaded
        ? <div className="cg-stagger"><strong>Loaded content</strong><p>Content fades in from a visible 15% and settles in 200ms.</p><p>Second child, 20ms later.</p></div>
        : <div className="cg-skeleton" aria-busy="true"><i className={`skeleton ${styles.skRow}`} style={{ width: "40%" }} /><i className={`skeleton ${styles.skRow}`} /><i className={`skeleton ${styles.skRow}`} style={{ width: "70%" }} /></div>}</div>
    </section>

    <section className={styles.sec}><h2>Long list (rows deliberately not animated)</h2><ul className={styles.list}>{ROWS.map(text => <li key={text}>{text}</li>)}</ul></section>
  </main>;
}
