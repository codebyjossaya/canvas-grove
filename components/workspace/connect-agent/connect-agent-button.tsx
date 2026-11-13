"use client";

import { useState } from "react";
import { AgentMark, STACK } from "./agent-icons";
import { ConnectAgentDialog, type InitialState } from "./connect-agent-dialog";
import type { ConnectionsData } from "./use-connections";
import styles from "./connect-agent.module.css";

/** Pill that opens the connect dialog. `fixture` / `initial` exist for the preview route only. */
export function ConnectAgentButton({ fixture, initial, initialOpen = false }: { fixture?: ConnectionsData; initial?: InitialState; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <>
    <button type="button" className={styles.pill} onClick={() => setOpen(true)} aria-haspopup="dialog">
      <span className={styles.stack} aria-hidden="true">{STACK.map(id => <span key={id} className={styles.stackTile}><AgentMark id={id} /></span>)}</span>
      <span>Connect agent</span>
    </button>
    <ConnectAgentDialog open={open} onClose={() => setOpen(false)} fixture={fixture} initial={initial} />
  </>;
}
