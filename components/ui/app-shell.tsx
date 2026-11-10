import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";
import { GroveMark, Icon } from "./icons";
import { SideNav } from "./side-nav";
import { BackgroundSyncStatus } from "./sync-status";
import { ThemeControl } from "./theme-provider";

// Rendered once by app/(workspace)/layout.tsx so the sidebar, top bar, sync status and
// account menu persist across client navigations instead of remounting per page.
export function AppShell({ children }: { children: ReactNode }) {
  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand sidebar-brand" href="/"><GroveMark/><span>Canvas Grove</span></Link>
      <SideNav/>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <Link className="mobile-brand brand" href="/" aria-label="Canvas Grove home"><GroveMark/><span>Canvas Grove</span></Link>
        <BackgroundSyncStatus compact/>
        <div className="top-actions"><ThemeControl compact/><span className="avatar-slot"><UserButton appearance={{ elements: { avatarBox: "avatar" } }}/></span></div>
      </header>
      {children}
    </div>
  </div>;
}

export function EmptySyncState({ icon, title, body, action }: { icon: string; title: string; body: string; action?: ReactNode }) {
  return <section className="empty-sync"><span className="empty-sync-icon"><Icon name={icon}/></span><h2>{title}</h2><p>{body}</p>{action && <div>{action}</div>}</section>;
}

// Stable placeholder for a route's main column while its data streams in. It mirrors the
// page header and panel rhythm so the real content replaces it without shifting the layout.
export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return <main className="dashboard route-page page-skeleton" aria-busy="true">
    <span className="sr-only" role="status">{label}</span>
    <div className="skeleton-head" aria-hidden="true"><i className="skeleton-line short"/><i className="skeleton-line title"/><i className="skeleton-line"/></div>
    <div className="skeleton-panel" aria-hidden="true"><i className="skeleton-line"/><i className="skeleton-line"/><i className="skeleton-line short"/></div>
  </main>;
}
