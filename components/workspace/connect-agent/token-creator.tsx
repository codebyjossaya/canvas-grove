"use client";

import { useId, useState } from "react";
import { READ_SCOPE_TEXT, WRITE_SCOPE_TEXT } from "@/lib/mcp/categories";
import type { AgentAccess } from "@/lib/scopes/catalog";
import { CopyButton } from "./copy-button";
import type { CreateResult, ExpiryChoice } from "./use-connections";
import styles from "./connect-agent.module.css";

const CHOICES: Array<{ label: string; value: ExpiryChoice }> = [{ label: "30 days", value: 30 }, { label: "90 days", value: 90 }, { label: "1 year", value: 365 }, { label: "Never expires", value: null }];

/** Create a personal access token. The token lives only in the parent's state and is shown once. */
/** The access choice is explicit and always sent; it is preselected from the saved default (read only when unknown). */
export function TokenCreator({ agentName, token, defaultAccess, onCreate }: { agentName: string; token: string | null; defaultAccess?: AgentAccess; onCreate: (name: string, expiresInDays: ExpiryChoice, allowActions: boolean) => Promise<CreateResult> }) {
  const id = useId();
  const [pickedAccess, setAccess] = useState<AgentAccess | null>(null);
  const access = pickedAccess ?? defaultAccess ?? "read";
  const [name, setName] = useState(`${agentName} token`);
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(Boolean(token));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    const expiry = days === "never" ? null : (Number(days) as ExpiryChoice);
    const result = await onCreate(name.trim(), expiry, access === "propose");
    setBusy(false);
    if (result.ok) setCreated(true); else setError(result.message);
  }

  if (token && created) return <div className={styles.tokenBox} role="group" aria-label="New access token">
    <p className={styles.tokenWarn}><strong>Copy this token now. You won&rsquo;t see it again.</strong> Grove only keeps a hash. Treat it like a password and revoke it from Your connections if it leaks.</p>
    <div className={styles.tokenRow}><code className={styles.tokenValue} tabIndex={0} aria-label="New access token value">{token}</code><CopyButton text={token} label="access token" variant="secondary">Copy token</CopyButton></div>
    <p className={styles.muted}>The commands below now include this token.</p>
  </div>;

  return <form className={styles.tokenForm} onSubmit={submit}>
    <h3 className={styles.sectionTitle}>Create access token</h3>
    <p className={styles.muted}>{agentName} sends this token as a password on every request.</p>
    <fieldset className={styles.accessChoice}>
      <legend className={styles.autoLegend}>What this token can do</legend>
      <label className={styles.checkRow}><input type="radio" name={`${id}-access`} checked={access === "read"} onChange={() => setAccess("read")} /><span><strong>Read only.</strong> {READ_SCOPE_TEXT}</span></label>
      <label className={styles.checkRow}><input type="radio" name={`${id}-access`} checked={access === "propose"} onChange={() => setAccess("propose")} /><span><strong>Read and propose actions.</strong> {WRITE_SCOPE_TEXT}</span></label>
    </fieldset>
    <div className={styles.formRow}>
      <label htmlFor={`${id}-name`}>Name<input id={`${id}-name`} value={name} maxLength={60} onChange={event => setName(event.target.value)} required autoComplete="off" /></label>
      <label htmlFor={`${id}-exp`}>Expires<select id={`${id}-exp`} value={days} onChange={event => setDays(event.target.value)}>{CHOICES.map(choice => <option key={choice.label} value={choice.value === null ? "never" : String(choice.value)}>{choice.label}</option>)}</select></label>
      <button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create token"}</button>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </form>;
}
