import { AppLink } from "@/components/ui/app-link";
import { CanvasSessionManager } from "@/components/ui/canvas-session";
import { BackgroundSyncStatus } from "@/components/ui/sync-status";
import { ThemeControl } from "@/components/ui/theme-provider";
import { TimeZoneSettings } from "@/components/ui/timezone-settings";
import styles from "./settings.module.css";

const shortcuts: Array<[string[], string]> = [
  [["Ctrl", "K"], "Open the command palette (⌘K on Mac)"],
  [["/"], "Search anything"],
  [["G", "T"], "Go to Today"], [["G", "P"], "Go to Planner"], [["G", "C"], "Go to Courses"], [["G", "I"], "Go to Inbox"], [["G", "Q"], "Go to Quizzes"], [["G", "S"], "Go to Settings"],
  [["J", "K"], "Next / previous item in Inbox"],
];

export function SettingsScreen() {
  return <main className={`page ${styles.page}`}>
    <header className="page-head"><div><h1>Settings</h1><p>Connection, sync, appearance and privacy.</p></div><div className="page-actions"><AppLink className="button secondary" href="/welcome?replay=1">Replay orientation</AppLink></div></header>
    <div className={styles.layout}>
      <nav className={styles.toc} aria-label="Settings sections">
        <a href="#connection">Canvas connection</a><a href="#sync">Sync</a><a href="#appearance">Appearance</a><a href="#time">Time zone</a><a href="#shortcuts">Keyboard</a>
      </nav>
      <div className={styles.sections}>
        <section id="connection" className={styles.section} aria-label="Canvas connection"><CanvasSessionManager /></section>
        <section id="sync" className={styles.section} aria-label="Sync"><BackgroundSyncStatus /></section>
        <section id="appearance" className={`panel ${styles.row}`} aria-labelledby="appearance-heading">
          <div><h2 id="appearance-heading">Appearance</h2><p>Light or dark. Resetting follows this device’s setting.</p></div>
          <ThemeControl allowSystemReset />
        </section>
        <section id="time" className={styles.section}><TimeZoneSettings /></section>
        <section id="shortcuts" className="panel" aria-labelledby="shortcuts-heading">
          <h2 id="shortcuts-heading">Keyboard shortcuts</h2>
          <dl className={styles.shortcuts}>{shortcuts.map(([keys, label]) => <div key={label}><dt>{keys.map(key => <kbd key={key} className="kbd">{key}</kbd>)}</dt><dd>{label}</dd></div>)}</dl>
        </section>
      </div>
    </div>
  </main>;
}
