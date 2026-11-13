"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppLink } from "./app-link";
import { Icon } from "./icons";

type Freshness = "fresh" | "stale" | "never";
type Resource = { name: string; lastSuccessfulSync?: string; freshness: Freshness; errorCode: string | null };
export type SyncState = "running" | "fresh" | "stale" | "idle" | "auth-expired" | "error";
type Status = { state: SyncState; lastSuccessfulSync?: string; nextScheduledSync?: string; resources: Resource[] };
export type SyncResponse = { resources: { kind: string; lastSuccessAt: string | null; freshness: Freshness; errorCode: string | null }[]; jobs: { status: string; runAfter: string; errorCode: string | null; manual?: boolean }[] };

export const SYNC_NOW_EVENT = "cg:sync-now";
/** Lets the command palette start a sync through the one mounted status controller. */
export function requestSyncNow() { window.dispatchEvent(new Event(SYNC_NOW_EVENT)); }

export function deriveSyncState(value: SyncResponse): SyncState {
  const codes = [...value.resources.map(r => r.errorCode), ...value.jobs.map(j => j.errorCode)].filter((code): code is string => Boolean(code)).map(code => code.toUpperCase());
  if (codes.some(code => code.includes("AUTH_EXPIRED") || code === "CANVAS_SESSION_EXPIRED" || code === "BROWSER_AUTH")) return "auth-expired";
  if (value.jobs.some(j => j.status === "running" || j.status === "leased")) return "running";
  if (codes.length > 0 || value.jobs.some(j => j.status === "failed")) return "error";
  if (value.resources.some(r => r.freshness === "stale")) return "stale";
  if (value.resources.length > 0 && value.resources.every(r => r.freshness === "fresh")) return "fresh";
  return "idle";
}
export function syncLabel(state: SyncState) {
  return { running: "Syncing Canvas", fresh: "Canvas data is fresh", stale: "Some Canvas data is stale", idle: "Sync is idle", "auth-expired": "Canvas sign-in expired", error: "Sync needs attention" }[state];
}

function relative(value?: string) {
  if (!value) return "Never synced";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "Unknown";
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(value).toLocaleString();
}
function relativeFuture(value: string) {
  const delta = new Date(value).getTime() - Date.now();
  if (delta <= 0) return "due now";
  if (delta < 3_600_000) return `in ${Math.ceil(delta / 60_000)}m`;
  return `in ${Math.ceil(delta / 3_600_000)}h`;
}
function resourceName(value: string) { return value.split(/[._-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" "); }
function stateGuidance(state: SyncState) {
  return { running: "Updates are being saved now.", fresh: "No action needed.", stale: "Saved data is available; a refresh is due.", idle: "No sync work is running.", "auth-expired": "Reconnect Canvas in Settings.", error: "Saved data is safe; review the affected resource." }[state];
}
function compactLabel(status: Status) {
  if (status.state === "running") return "Syncing…";
  if (status.state === "auth-expired") return "Reconnect Canvas";
  if (status.state === "error") return "Sync needs attention";
  if (status.state === "stale") return `Stale · ${relative(status.lastSuccessfulSync).toLowerCase()}`;
  if (status.state === "fresh") return `Synced ${relative(status.lastSuccessfulSync).toLowerCase()}`;
  return status.nextScheduledSync ? `Next sync ${relativeFuture(status.nextScheduledSync)}` : "Sync idle";
}

/** One status fetch shared by every mounted controller (sidebar, top bar, settings panel). */
const shared: { promise: Promise<Response> | null; at: number; value: SyncResponse | null; ok: boolean; status: number } = { promise: null, at: 0, value: null, ok: false, status: 0 };
const FRESH_WINDOW_MS = 8_000;
async function sharedStatus(force: boolean): Promise<{ ok: boolean; status: number; value: SyncResponse & { error?: string } }> {
  if (!force && !shared.promise && shared.value && shared.ok && Date.now() - shared.at < FRESH_WINDOW_MS) return { ok: true, status: shared.status, value: shared.value };
  // Never overlap requests: concurrent callers share the one in-flight fetch.
  if (!shared.promise) {
    shared.promise = fetch("/api/canvas/sync/status", { cache: "no-cache" }).then(async response => {
      const value = await response.json() as SyncResponse;
      shared.value = value; shared.ok = response.ok; shared.status = response.status; shared.at = Date.now();
      return response;
    }).finally(() => { shared.promise = null; });
  }
  const response = await shared.promise;
  return { ok: response.ok, status: response.status, value: shared.value as SyncResponse & { error?: string } };
}

const POLL_MS = [60_000, 120_000, 300_000], RUNNING_POLL_MS = 10_000;

function useSyncController() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null), [checking, setChecking] = useState(false), [syncing, setSyncing] = useState(false), [error, setError] = useState("");
  const signature = useRef("");
  const [changed, setChanged] = useState(0);
  const load = useCallback(async (force = false): Promise<SyncResponse | null> => {
    try {
      const { ok, status: httpStatus, value } = await sharedStatus(force);
      const response = { ok, status: httpStatus };
      if (!response.ok) { setError(response.status === 401 ? "Your Canvas Grove session expired. Sign in again to check sync status." : response.status === 404 ? "Sync has not been initialized yet. Your saved data is unchanged." : "Sync status is temporarily unavailable. Your saved data remains safe."); return null; }
      const scheduled = value.jobs.filter(j => j.status === "queued").sort((a, b) => a.runAfter.localeCompare(b.runAfter))[0];
      const successes = value.resources.map(r => r.lastSuccessAt).filter((v): v is string => Boolean(v)).sort().reverse();
      const next = JSON.stringify([value.resources, value.jobs.map(j => [j.status, j.errorCode, j.runAfter])]);
      if (next !== signature.current) { signature.current = next; setChanged(count => count + 1); }
      setStatus({ state: deriveSyncState(value), lastSuccessfulSync: successes[0], nextScheduledSync: scheduled?.runAfter, resources: value.resources.map(r => ({ name: resourceName(r.kind), lastSuccessfulSync: r.lastSuccessAt ?? undefined, freshness: r.freshness, errorCode: r.errorCode })) });
      setError("");
      return value;
    } catch {
      setError(!navigator.onLine ? "This device is offline. Previously synced data remains available." : "Canvas Grove could not check sync status. Your saved data remains safe.");
      return null;
    }
  }, []);
  // Poll gently: first check shortly after paint, then back off (1m, 2m, 5m) while nothing
  // changes, every 10s while a sync is running, and not at all while the tab is hidden (it
  // catches up the moment the tab is shown again).
  const quiet = useRef(0);
  useEffect(() => { quiet.current = 0; }, [changed]);
  const running = status?.state === "running";
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, cancelled = false;
    const schedule = (delay: number) => { timer = setTimeout(tick, delay); };
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return; // resumed by visibilitychange
      await load();
      if (cancelled) return;
      const delay = running ? RUNNING_POLL_MS : POLL_MS[Math.min(quiet.current, POLL_MS.length - 1)];
      quiet.current += 1;
      schedule(delay);
    };
    const onVisible = () => { if (document.visibilityState === "visible" && !cancelled) { clearTimeout(timer); void tick(); } };
    schedule(1500);
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, running]);
  async function refresh() { setChecking(true); await load(true); setChecking(false); }
  const syncNow = useCallback(async () => {
    if(syncing)return;
    setSyncing(true); setError("");
    try {
      const response = await fetch("/api/canvas/sync/status", { method: "POST" }), value = await response.json() as { error?: string; code?: string };
      if (!response.ok) {
        if (value.code === "BROWSER_AUTH_EXPIRED") throw new Error("Canvas sign-in expired. Reconnect Canvas, then retry.");
        if (response.status === 425) throw new Error("Canvas sync is still starting. Retry shortly.");
        throw new Error(value.error || "Canvas sync could not start. Retry shortly.");
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const current = await load(true);
        if (!current) break;
        if (!current.jobs.some(job => job.manual && ["queued", "leased", "running"].includes(job.status))) { router.refresh(); break; }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Canvas sync could not start. Retry shortly."); }
    finally { setSyncing(false); }
  }, [load, router, syncing]);
  return { status, checking, syncing, error, refresh, syncNow };
}

export function BackgroundSyncStatus({ compact = false }: { compact?: boolean }) {
  return compact ? <CompactSyncStatus /> : <SyncPanel />;
}

/** Sidebar/top-bar status: quiet dot + label; the popover shows per-resource freshness. */
function CompactSyncStatus() {
  const { status, syncing, error, syncNow } = useSyncController();
  useEffect(() => {
    const onRequest = () => void syncNow();
    window.addEventListener(SYNC_NOW_EVENT, onRequest);
    return () => window.removeEventListener(SYNC_NOW_EVENT, onRequest);
  }, [syncNow]);
  const state = syncing ? "running" : status?.state ?? (error ? "error" : "loading");
  const label = syncing ? "Syncing…" : status ? compactLabel(status) : error ? "Sync unavailable" : "Checking sync";
  return <div className="sync-compact-wrap">
    <button type="button" className={`sync-compact ${state}`} popoverTarget="sync-popover" aria-label={`${label}. Sync details`}>
      <i aria-hidden="true" /><span>{label}</span>
    </button>
    <div id="sync-popover" popover="auto" className="sync-popover" aria-label="Canvas sync">
      <div className="sync-popover-head" role="status" aria-live="polite">
        <span className={`sync-dot ${state}`} aria-hidden="true" />
        <div><strong>{status ? syncLabel(syncing ? "running" : status.state) : error ? "Sync status unavailable" : "Checking sync…"}</strong><small>{status ? `Last success ${relative(status.lastSuccessfulSync).toLowerCase()}` : error}</small></div>
      </div>
      {status && status.resources.length > 0 && <ul className="sync-popover-list">{status.resources.map(item => <li key={item.name}><span>{item.name}</span><span className={item.errorCode ? "error" : item.freshness}>{item.errorCode ? "Needs attention" : item.freshness === "fresh" ? relative(item.lastSuccessfulSync) : item.freshness === "stale" ? "Stale" : "Not synced"}</span></li>)}</ul>}
      {error && status && <p className="sync-popover-error" role="alert">{error}</p>}
      <div className="sync-popover-actions">
        <button className="button primary" disabled={syncing} aria-busy={syncing} onClick={() => void syncNow()}><Icon name="refresh" />{syncing ? "Syncing…" : "Sync now"}</button>
        <AppLink className="button ghost" href="/settings">Sync settings</AppLink>
      </div>
    </div>
  </div>;
}

function SyncPanel() {
  const { status, checking, syncing, error, refresh, syncNow } = useSyncController();
  return <section className="sync-panel" aria-labelledby="sync-title">
    <div className="sync-panel-head">
      <div><h2 id="sync-title">Background sync</h2><p>Scheduled updates continue while this app is closed. Freshness reflects the last successful Canvas update.</p></div>
      <div><button className="button primary" disabled={syncing} aria-busy={syncing} onClick={() => void syncNow()}><Icon name="refresh" />{syncing ? "Syncing…" : "Sync now"}</button><button className="button secondary" disabled={checking || syncing} onClick={() => void refresh()}>{checking ? "Checking…" : "Check status"}</button></div>
    </div>
    {status && <>
      <div className={`sync-health ${status.state}`} role="status" aria-live="polite"><i /><div><strong>{syncLabel(status.state)}</strong><small>{stateGuidance(status.state)}</small></div><span>Last success <b>{relative(status.lastSuccessfulSync)}</b></span><span>Next check <b>{status.nextScheduledSync ? relativeFuture(status.nextScheduledSync) : "Not scheduled"}</b></span></div>
      {status.resources.length > 0 ? <div className="resource-freshness">{status.resources.map(item => <div key={item.name}><span>{item.name}</span><strong className={item.errorCode ? "error" : item.freshness}>{item.errorCode ? "Needs attention" : item.freshness === "fresh" ? "Fresh" : item.freshness === "stale" ? "Stale" : "Not synced"}</strong><small>Last success: {relative(item.lastSuccessfulSync)}</small></div>)}</div> : <p className="sync-unavailable">No Canvas resources have synced yet. Connect Canvas to begin scheduled updates.</p>}
    </>}
    {!status && !error && <p className="sync-unavailable" role="status">Checking sync status…</p>}
    {error && <p className="session-error" role="alert">{error}</p>}
    <small className="manual-note">Sync now queues the same durable, deduplicated jobs used by background sync. Canvas sign-in expired? Reconnect below.</small>
  </section>;
}
