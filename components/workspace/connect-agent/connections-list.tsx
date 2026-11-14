"use client";

import { useEffect, useRef, useState } from "react";
import type { AutoTarget } from "../approvals/auto-model";
import { AutoModeRow, type AutoPreview } from "./auto-mode-row";
import { useAutoMode } from "./use-auto-mode";
import { useConnections, type Connections, type ConnectionsData } from "./use-connections";
import styles from "./connect-agent.module.css";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmt = (iso: string | null, empty: string) => iso ? dateFormat.format(new Date(iso)) : empty;

type Row = { key: string; id: string; kind: "tokens" | "grants"; title: string; badge: string; meta: Array<[string, string]> };

function toRows(data: ConnectionsData): Row[] {
  const tokens = data.tokens.map<Row>(token => ({ key: `t-${token.id}`, id: token.id, kind: "tokens", title: token.name, badge: "Access token", meta: [["Prefix", token.prefix], ["Created", fmt(token.createdAt, "-")], ["Last used", fmt(token.lastUsedAt, "Never")], ["Expires", fmt(token.expiresAt, "Never")]] }));
  const grants = data.grants.map<Row>(grant => ({ key: `g-${grant.id}`, id: grant.id, kind: "grants", title: grant.clientName, badge: "OAuth", meta: [["Created", fmt(grant.createdAt, "-")], ["Last used", fmt(grant.lastUsedAt, "Never")]] }));
  return [...grants, ...tokens];
}

/** Your access tokens and OAuth grants, with revoke. */
export function ConnectionsList({ connections, headingLevel = 3, autoTargets, autoPreview }: { connections: Connections; headingLevel?: 2 | 3; autoTargets?: AutoTarget[]; autoPreview?: Record<string, AutoPreview> }) {
  const { state, reload, revokeToken, revokeGrant } = connections;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreTrigger = useRef<string | null>(null);
  // Fixture connections never touch the network, so auto mode uses fixtures too.
  const autoMode = useAutoMode(connections.isFixture ? autoTargets ?? [] : undefined);
  const rows = state.data ? toRows(state.data) : [];
  const Heading = `h${headingLevel}` as "h2" | "h3";
  useEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (restoreTrigger.current) {
      const key = restoreTrigger.current;
      restoreTrigger.current = null;
      triggers.current[key]?.focus();
    }
  }, [confirming]);
  async function revoke(row: Row) {
    if (revoking) return;
    const index = rows.findIndex((item) => item.key === row.key);
    const nextKey = rows[index + 1]?.key ?? rows[index - 1]?.key;
    setRevoking(row.key);
    const removed = await (row.kind === "tokens" ? revokeToken(row.id) : revokeGrant(row.id));
    setConfirming(null);
    setRevoking(null);
    window.requestAnimationFrame(() => (removed && nextKey ? triggers.current[nextKey] : heading.current)?.focus());
  }
  function cancelRevoke(key: string) {
    restoreTrigger.current = key;
    setConfirming(null);
  }
  return <div className={styles.connections}>
    <Heading ref={heading} tabIndex={-1} className={styles.sectionTitle}>Your connections</Heading>
    {state.status === "loading" && !state.data ? <p className={styles.muted} role="status">Loading…</p> : null}
    {state.status === "error" ? <p className={styles.error} role="alert">{state.message} <button type="button" className={styles.linkButton} onClick={reload}>Try again</button></p> : null}
    {state.status === "ready" && state.message ? <p className={styles.error} role="alert">{state.message}</p> : null}
    {state.status !== "loading" && state.data && rows.length === 0 ? <p className={styles.muted}>No agents connected yet. Pick one above to get started.</p> : null}
    {rows.length ? <ul className={styles.connList}>{rows.map(row => <li key={row.key} className={styles.connItem}>
      <div className={styles.connMain}>
        <div className={styles.connTitle}><span>{row.title}</span><span className="chip">{row.badge}</span></div>
        <dl className={styles.connMeta}>{row.meta.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </div>
      {(() => { const kind = row.kind === "tokens" ? "token" : "grant"; const target = autoMode.state.targets.find(item => item.kind === kind && item.id === row.id); return target ? <div className={styles.connAuto}><AutoModeRow target={target} api={autoMode} preview={autoPreview?.[`${kind}:${row.id}`]} /></div> : null; })()}
      {confirming === row.key ? <div className="page-actions" role="group" aria-label={`Confirm revoke ${row.title}`}>
        <button type="button" className="danger-button" disabled={revoking === row.key} aria-busy={revoking === row.key} onClick={() => void revoke(row)}>Confirm revoke</button>
        <button ref={cancel} type="button" className="button ghost" disabled={revoking === row.key} onClick={() => cancelRevoke(row.key)}>Keep access</button>
      </div> : <button ref={node => { triggers.current[row.key] = node; }} type="button" className="danger-button" aria-label={`Revoke ${row.title} (${row.badge})`} onClick={() => setConfirming(row.key)}>Revoke</button>}
    </li>)}</ul> : null}
  </div>;
}

/** Self-contained version for the Settings page. */
export function ConnectionsSection({ fixture, autoTargets, autoPreview }: { fixture?: ConnectionsData; autoTargets?: AutoTarget[]; autoPreview?: Record<string, AutoPreview> }) {
  return <ConnectionsList connections={useConnections(fixture)} autoTargets={autoTargets} autoPreview={autoPreview} />;
}
