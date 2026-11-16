"use client";

import { ConnectAgentEmbedded } from "@/components/workspace/connect-agent/connect-agent-dialog";
import type { Connections } from "@/components/workspace/connect-agent/use-connections";
import type { AgentId, AuthMode } from "@/lib/connect-agent/catalog";
import { AGENT_ACCESS_INFO, type AgentAccess } from "@/lib/scopes/catalog";
import type { AgentConnection } from "./model";
import { Callout, StepFooter, StepHeader, SuccessLine, Watching } from "./shell";
import styles from "./orientation.module.css";

/**
 * Step 6 (optional). The connection list is polled while this step is open; a connection that was
 * not there when the step opened counts as "just connected".
 */
export function StepAgent({ connections, access, detected, existing, onEditAccess, onBack, onNext, initialAgent, initialMode, initialToken }: {
  connections: Connections;
  access: AgentAccess;
  detected: AgentConnection | null;
  existing: AgentConnection[];
  onEditAccess: () => void;
  onBack: () => void;
  onNext: () => void;
  /** Fixture preview only. */
  initialAgent?: AgentId; initialMode?: AuthMode; initialToken?: string;
}) {
  const done = Boolean(detected) || existing.length > 0;
  return <>
    <StepHeader title="Connect your AI agent">
      Let an assistant like Claude or ChatGPT read your coursework through Grove. Anything it wants to do in Canvas waits for your approval.
    </StepHeader>
    {detected ? <SuccessLine><strong>{detected.name}</strong> is connected ({detected.kind}).</SuccessLine>
      : existing.length ? <SuccessLine>Already connected: {existing.map((item) => item.name).join(", ")}.</SuccessLine> : null}
    <p className={styles.note}>
      New connections can: <strong>{AGENT_ACCESS_INFO[access].label.toLowerCase()}</strong>.{" "}
      <button type="button" className={styles.inlineButton} onClick={onEditAccess}>Change in Allow data</button>
    </p>
    {connections.state.status === "error" && !connections.state.data ? <Callout tone="warning" title="Your connections did not load" action={<button type="button" className="button secondary" onClick={connections.reload}>Load again</button>}>
      <p>You can still follow a guide below. Grove notices the new connection once the list loads.</p>
    </Callout> : null}
    <section className={styles.section} aria-labelledby="orientation-agents">
      <h2 id="orientation-agents" className={styles.sectionTitle}>{done ? "Connect another agent" : "Choose your agent"}</h2>
      <ConnectAgentEmbedded connections={connections} initialAgent={initialAgent} initialMode={initialMode} initialToken={initialToken} />
      {!done ? <Watching>Watching for a new connection. This page updates when your agent signs in.</Watching> : null}
    </section>
    <StepFooter
      onBack={onBack}
      primary={{ label: done ? "Continue" : "Set up later", onClick: onNext, icon: done ? "arrow" : undefined }}
      quiet={!done}
      helper={done ? undefined : "You can connect an agent anytime from Settings."}
    />
  </>;
}
