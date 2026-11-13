"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icons";
import { GroveMark } from "@/components/ui/icons";
import { WORKFLOW_LABELS, agentsFor, getAgent, type AgentId, type AuthMode, type Workflow } from "@/lib/connect-agent/catalog";
import { buildPrompt } from "@/lib/connect-agent/guides";
import { AgentMark } from "./agent-icons";
import { ConnectionsList } from "./connections-list";
import { CopyButton } from "./copy-button";
import { GuideView } from "./guide-view";
import { useConnections, type ConnectionsData } from "./use-connections";
import styles from "./connect-agent.module.css";

export type InitialState = { agent?: AgentId; mode?: AuthMode; filter?: Workflow | "all"; token?: string };
const FILTERS: Array<Workflow | "all"> = ["all", "app", "terminal", "ide"];
const noop = () => () => {};

function Body({ fixture, initial }: { fixture?: ConnectionsData; initial?: InitialState }) {
  const connections = useConnections(fixture);
  const [agentId, setAgentId] = useState<AgentId | null>(getAgent(initial?.agent)?.id ?? null);
  const [filter, setFilter] = useState<Workflow | "all">(initial?.filter ?? "all");
  const [fallbackUrl] = useState(() => `${window.location.origin}/mcp`);
  const serverUrl = connections.state.data?.serverUrl || fallbackUrl;
  const visible = agentsFor(filter);

  return <>
    <div className={styles.dialogTools}>
      <p className={styles.lead}>Grove&rsquo;s MCP server lets an AI assistant read your courses, assignments and grades. Actions it proposes wait for your approval in Grove, and it never sees your Canvas password.</p>
      <CopyButton text={buildPrompt({ serverUrl })} label="agent prompt" variant="secondary">Copy prompt</CopyButton>
    </div>
    {agentId ? <GuideView key={agentId} agentId={agentId} serverUrl={serverUrl} connections={connections} onBack={() => setAgentId(null)} initialMode={initial?.mode} initialToken={initial?.token} /> : <>
      <div className={styles.filters} role="group" aria-label="Filter by workflow">
        {FILTERS.map(key => <button key={key} type="button" className={styles.filterChip} aria-pressed={filter === key} onClick={() => setFilter(key)}>{WORKFLOW_LABELS[key]}</button>)}
      </div>
      <ul className={styles.grid}>{visible.map(agent => <li key={agent.id}>
        <button type="button" className={styles.card} onClick={() => setAgentId(agent.id)}>
          <span className={styles.tile}><AgentMark id={agent.id} /></span>
          <span className={styles.vendor}>{agent.vendor}</span>
          <span className={styles.cardName}>{agent.name}</span>
          <span className={styles.cardBlurb}>{agent.blurb}</span>
          <span className={styles.cardCta}>View guide <Icon name="arrow" /></span>
        </button>
      </li>)}</ul>
      {visible.length === 0 ? <p className={styles.muted}>No agents in this group.</p> : null}
    </>}
    <ConnectionsList connections={connections} />
  </>;
}

/** Native <dialog>: focus trap, Esc and inert background come from the browser. */
export function ConnectAgentDialog({ open, onClose, fixture, initial }: { open: boolean; onClose: () => void; fixture?: ConnectionsData; initial?: InitialState }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, hydrated]);

  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.dialogInner}>
      <header className={styles.dialogHead}>
        <GroveMark />
        <h2 id={titleId}>Connect an agent to Canvas Grove</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className={styles.dialogBody}>{open && hydrated ? <Body fixture={fixture} initial={initial} /> : null}</div>
    </div>
  </dialog>;
}

