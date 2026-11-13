"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { getAgent, needsToken, defaultMode, type AgentId, type AuthMode } from "@/lib/connect-agent/catalog";
import { guideFor } from "@/lib/connect-agent/guides";
import { AgentMark } from "./agent-icons";
import { CopyButton } from "./copy-button";
import { TokenCreator } from "./token-creator";
import type { Connections } from "./use-connections";
import styles from "./connect-agent.module.css";

export function GuideView({ agentId, serverUrl, connections, onBack, initialMode, initialToken }: { agentId: AgentId; serverUrl: string; connections: Connections; onBack: () => void; initialMode?: AuthMode; initialToken?: string }) {
  const agent = getAgent(agentId)!;
  const [mode, setMode] = useState<AuthMode>(initialMode ?? defaultMode(agent));
  // Held in memory only: never stored, never put in a URL, cleared when this view unmounts.
  const [token, setToken] = useState<string | null>(initialToken ?? null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [agentId]);
  const guide = useMemo(() => guideFor(agentId, { serverUrl, token, mode }), [agentId, serverUrl, token, mode]);
  const tokenNeeded = needsToken(agent, mode);

  return <div className={styles.guide}>
    <button type="button" className={`button ghost ${styles.back}`} onClick={onBack}><Icon name="arrow-left" />All agents</button>
    <div className={styles.guideHead}>
      <span className={styles.tile}><AgentMark id={agentId} /></span>
      <div><p className={styles.vendor}>{agent.vendor}</p><h2 ref={heading} tabIndex={-1} className={styles.guideTitle}>{agent.name}</h2></div>
    </div>
    {agent.auth === "either" ? <div className={styles.seg} role="group" aria-label="Sign-in method">
      <button type="button" aria-pressed={mode === "oauth"} onClick={() => setMode("oauth")}>Sign in with OAuth <span>recommended</span></button>
      <button type="button" aria-pressed={mode === "token"} onClick={() => setMode("token")}>Access token</button>
    </div> : <p className={styles.muted}>{agent.auth === "oauth" ? "Signs in with OAuth: just the URL, no token to create." : "Uses a Grove access token."}</p>}
    {tokenNeeded ? <TokenCreator agentName={agent.name} token={token} onCreate={async (name, days) => { const result = await connections.createToken(name, days); if (result.ok) setToken(result.token); return result; }} /> : null}
    {guide.deeplink ? <a className="button primary" href={guide.deeplink.href}>{guide.deeplink.label}<Icon name="external" /></a> : guide.noDeeplinkReason ? <p className={styles.muted}>{guide.noDeeplinkReason}</p> : null}
    <ol className={styles.steps}>{guide.steps.map((step, index) => <li key={index}>
      <span className={styles.stepText}>{step.text}</span>
      {step.copy ? <div className={styles.cmd}><code>{step.copy}</code><CopyButton text={step.copy} label={`step ${index + 1}`} /></div> : null}
    </li>)}</ol>
    {guide.snippets.map(snippet => <figure key={snippet.label} className={styles.snippet}>
      <figcaption><span>{snippet.label}</span><CopyButton text={snippet.code} label={snippet.label}>Copy</CopyButton></figcaption>
      <pre tabIndex={0}><code>{snippet.code}</code></pre>
    </figure>)}
    {guide.notes.length ? <ul className={styles.notes}>{guide.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
  </div>;
}
