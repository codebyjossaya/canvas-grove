import type { ReactNode } from "react";
import { AppLink } from "./app-link";
import { CommandPalette, PaletteTrigger } from "./command-palette";
import { GroveMark, Icon } from "./icons";
import { ShellEffects } from "./shell-effects";
import { SettingsLink, SideNav, TabBar } from "./side-nav";
import { BackgroundSyncStatus } from "./sync-status";
import { ThemeControl } from "./theme-provider";
import { SkeletonTransition } from "./page-transition";

// Rendered once by app/(workspace)/layout.tsx so the sidebar, sync status, palette and account
// menu persist across client navigations; only the main column re-renders. `courses` and `user`
// are slots so the layout can stream them and the dev fixture preview can supply its own.
export function AppShell({ children, courses, user }: { children: ReactNode; courses?: ReactNode; user?: ReactNode }) {
  return <div className="app">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="app-sidebar" aria-label="Sidebar">
      <div className="sidebar-head"><AppLink className="brand" href="/"><GroveMark /><span>Canvas Grove</span></AppLink></div>
      <PaletteTrigger />
      <SideNav />
      {courses}
      <div className="sidebar-foot">
        <SettingsLink />
        <BackgroundSyncStatus compact />
        <div className="sidebar-foot-row"><span className="avatar-slot">{user}</span><ThemeControl compact /></div>
      </div>
    </aside>
    <div className="app-main">
      <header className="app-topbar">
        <AppLink className="brand" href="/" aria-label="Canvas Grove, Today"><GroveMark /><span>Canvas Grove</span></AppLink>
        <PaletteTrigger variant="icon" />
        <BackgroundSyncStatus compact />
        <span className="avatar-slot">{user}</span>
      </header>
      <div id="main" className="app-content" tabIndex={-1}>{children}</div>
    </div>
    <TabBar />
    <CommandPalette />
    <ShellEffects />
  </div>;
}

export function EmptySyncState({ icon, title, body, action }: { icon: string; title: string; body: string; action?: ReactNode }) {
  return <section className="empty-state"><span className="empty-icon"><Icon name={icon} /></span><h2>{title}</h2><p>{body}</p>{action && <div className="actions">{action}</div>}</section>;
}

// Stable placeholder for a route's main column while its data streams in. It mirrors the page
// header and list rhythm so the real content replaces it without shifting the layout.
export function PageSkeleton({ label = "Loading", rows = 7 }: { label?: string; rows?: number }) {
  return <SkeletonTransition><main className="page page-skeleton" aria-busy="true">
    <span className="sr-only" role="status">{label}</span>
    <div className="sk-head" aria-hidden="true"><i className="skeleton" style={{ width: 160, height: 24 }} /><i className="skeleton" style={{ width: 280, height: 14 }} /></div>
    <div className="sk-rows" aria-hidden="true">{Array.from({ length: rows }, (_, index) => <div className="sk-row" key={index}><i className="skeleton" style={{ width: 8, height: 8 }} /><i className="skeleton" style={{ width: `${48 + ((index * 17) % 40)}%`, height: 12 }} /><i className="skeleton" style={{ width: 64, height: 12, justifySelf: "end" }} /></div>)}</div>
  </main></SkeletonTransition>;
}
