import { AppLink } from "@/components/ui/app-link";
import { CanvasSessionManager } from "@/components/ui/canvas-session";
import { ConnectAgentButton } from "./connect-agent/connect-agent-button";
import { ConnectionsSection } from "./connect-agent/connections-list";
import type { ConnectionsData } from "./connect-agent/use-connections";
import type { AutoTarget } from "./approvals/auto-model";
import { ExtensionDevices, type ExtensionDeviceFixture } from "./extension-devices";
import { ScopesSettings } from "./scopes-settings";
import type { ScopeSettings } from "@/lib/scopes/catalog";
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

export function SettingsScreen({ fixtures }: { fixtures?: { connections: ConnectionsData; autoTargets: AutoTarget[]; extensionDevices: ExtensionDeviceFixture[]; scopes?: ScopeSettings } }) {
  return <main className={`page ${styles.page}`}>
    <header className={`page-head ${styles.header}`}><div><p className="eyebrow">Your workspace</p><h1>Settings</h1><p>Connection, sync, appearance and privacy.</p></div><div className={`page-actions ${styles.headerActions}`}><ConnectAgentButton fixture={fixtures?.connections} /><AppLink className="button secondary" href="/welcome?replay=1">Replay orientation</AppLink></div></header>
    <div className={styles.layout}>
      <aside className={styles.navigation}><p>On this page</p><nav className={styles.toc} aria-label="Settings sections">
        <a href="#connection">Canvas connection</a><a href="#extension">Browser extension</a><a href="#data">Data &amp; permissions</a><a href="#agents">Agents (MCP)</a><a href="#sync">Background sync</a><a href="#appearance">Appearance</a><a href="#time">Time zone</a><a href="#shortcuts">Keyboard</a>
      </nav></aside>
      <div className={styles.sections}>
        <section id="connection" className={styles.section} aria-label="Canvas connection"><CanvasSessionManager /></section>
        <ExtensionDevices fixture={fixtures?.extensionDevices} />
        <ScopesSettings fixture={fixtures?.scopes} />
        <section id="agents" className="panel" aria-labelledby="agents-heading">
          <h2 id="agents-heading">Agents (MCP)</h2>
          <p>Let an AI assistant such as Claude, ChatGPT, Cursor or Codex read your courses, assignments and grades. By default it is read-only. Anything it proposes, such as submitting work, waits for your approval, and you can revoke access at any time.</p>
          <ConnectionsSection fixture={fixtures?.connections} autoTargets={fixtures?.autoTargets} />
        </section>
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
