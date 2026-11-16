"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { AUTO_CATEGORIES, CATEGORY_INFO, type AutoCategory } from "@/lib/mcp/categories";
import {
  AGENT_ACCESS, AGENT_ACCESS_INFO, DATA_SCOPES, DATA_SCOPE_INFO, NEVER_ACCESSED, SCOPE_OFF_NOTE, normalizeDataScopes,
  type AgentAccess, type DataScope, type ScopeSettings,
} from "@/lib/scopes/catalog";
import styles from "./scopes-settings.module.css";

// Settings > Data & permissions. All labels and descriptions come from lib/scopes/catalog so the
// orientation scopes step and this section always say the same thing.

const ENDPOINT = "/api/settings/scopes";
const headers = { "x-grove-csrf": "1" };

type Draft = Omit<ScopeSettings, "savedAt">;
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; saved: ScopeSettings };
type Save = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "error"; message: string };

const sameDraft = (a: Draft, b: Draft) => a.data.join() === b.data.join() && a.agent.access === b.agent.access && a.agent.autoCategories.join() === b.agent.autoCategories.join();
const toDraft = (settings: ScopeSettings): Draft => ({ data: [...settings.data], agent: { access: settings.agent.access, autoCategories: [...settings.agent.autoCategories] } });
const savedLabel = (iso: string | null) => iso ? `Last saved ${new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` : "Using the defaults. Nothing saved yet.";

async function errorMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

export function ScopesSettings({ fixture }: { fixture?: ScopeSettings }) {
  const [load, setLoad] = useState<Load>(fixture ? { state: "ready", saved: fixture } : { state: "loading" });
  const [draft, setDraft] = useState<Draft | null>(fixture ? toDraft(fixture) : null);
  const [save, setSave] = useState<Save>({ state: "idle" });
  const ids = useId();

  const fetchSettings = useCallback(async () => {
    if (fixture) return;
    setLoad({ state: "loading" });
    try {
      const response = await fetch(ENDPOINT, { headers, cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "Grove could not load your data settings."));
      const saved = await response.json() as ScopeSettings;
      setLoad({ state: "ready", saved });
      setDraft(toDraft(saved));
    } catch (error) {
      setLoad({ state: "error", message: error instanceof Error && error.message ? error.message : "Grove could not load your data settings." });
    }
  }, [fixture]);

  useEffect(() => {
    if (fixture) return;
    let live = true;
    fetch(ENDPOINT, { headers, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<ScopeSettings> : Promise.reject(new Error(await errorMessage(response, "Grove could not load your data settings."))))
      .then((saved) => { if (live) { setLoad({ state: "ready", saved }); setDraft(toDraft(saved)); } })
      .catch((error: unknown) => { if (live) setLoad({ state: "error", message: error instanceof Error && error.message ? error.message : "Grove could not load your data settings." }); });
    return () => { live = false; };
  }, [fixture]);

  const saved = load.state === "ready" ? load.saved : null;
  const dirty = useMemo(() => Boolean(saved && draft && !sameDraft(toDraft(saved), draft)), [saved, draft]);

  function edit(next: (current: Draft) => Draft) {
    setDraft((current) => (current ? next(current) : current));
    setSave({ state: "idle" });
  }
  const toggleScope = (scope: DataScope, on: boolean) => edit((current) => ({ ...current, data: normalizeDataScopes(on ? [...current.data, scope] : current.data.filter((item) => item !== scope)) }));
  const setAccess = (access: AgentAccess) => edit((current) => ({ ...current, agent: { access, autoCategories: access === "propose" ? current.agent.autoCategories : [] } }));
  const toggleCategory = (category: AutoCategory, on: boolean) => edit((current) => {
    const set = new Set(current.agent.autoCategories);
    if (on) set.add(category); else set.delete(category);
    return { ...current, agent: { ...current.agent, autoCategories: AUTO_CATEGORIES.filter((item) => set.has(item)) } };
  });

  async function submit() {
    if (!draft || !dirty || save.state === "saving") return;
    if (fixture) { setLoad({ state: "ready", saved: { ...draft, savedAt: new Date().toISOString() } }); setSave({ state: "saved" }); return; }
    setSave({ state: "saving" });
    try {
      const response = await fetch(ENDPOINT, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(draft), cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "Grove could not save your data settings. Your previous settings are unchanged."));
      const next = await response.json() as ScopeSettings;
      setLoad({ state: "ready", saved: next });
      setDraft(toDraft(next));
      setSave({ state: "saved" });
    } catch (error) {
      setSave({ state: "error", message: error instanceof Error && error.message ? error.message : "Grove could not save your data settings." });
    }
  }

  const turnedOff = saved && draft ? saved.data.filter((scope) => !draft.data.includes(scope)) : [];

  return <section id="data" className="panel" aria-labelledby={`${ids}-heading`}>
    <h2 id={`${ids}-heading`}>Data &amp; permissions</h2>
    <p className={styles.lead}>Choose which Canvas data Grove syncs, and what newly connected agents may do by default.</p>

    {load.state === "loading" ? <p className={styles.muted} role="status">Loading your data settings…</p> : null}
    {load.state === "error" ? <div className={styles.problem} role="alert">
      <p>{load.message}</p>
      <button type="button" className="button secondary" onClick={() => void fetchSettings()}>Try again</button>
    </div> : null}

    {load.state === "ready" && draft ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Canvas data Grove may read</legend>
        <ul className={styles.list}>
          {DATA_SCOPES.map((scope) => {
            const info = DATA_SCOPE_INFO[scope];
            const id = `${ids}-scope-${scope}`;
            return <li key={scope} className={styles.row}>
              <input id={id} type="checkbox" className={styles.check} checked={draft.data.includes(scope)} disabled={info.required === true}
                aria-describedby={`${id}-desc`} onChange={(event) => toggleScope(scope, event.target.checked)} />
              <div className={styles.text}>
                <label htmlFor={id} className={styles.label}>{info.label}{info.required ? <span className={styles.required}>Required</span> : null}</label>
                <p id={`${id}-desc`} className={styles.description}>{info.description}</p>
                <details className={styles.details}><summary>Details</summary><p>{info.detail}</p></details>
              </div>
            </li>;
          })}
        </ul>
        <p className={styles.note}>{SCOPE_OFF_NOTE}</p>
        {turnedOff.length ? <p className={styles.warning} role="status">Saving stops syncing {turnedOff.map((scope) => DATA_SCOPE_INFO[scope].label.toLowerCase()).join(", ")}.</p> : null}
        <div className={styles.never}>
          <p className={styles.neverTitle}>Grove never reads</p>
          <ul>{NEVER_ACCESSED.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Default for new agent connections</legend>
        <div className={styles.list}>
          {AGENT_ACCESS.map((access) => {
            const id = `${ids}-access-${access}`;
            return <div key={access} className={styles.row}>
              <input id={id} type="radio" name={`${ids}-access`} className={styles.check} value={access} checked={draft.agent.access === access}
                aria-describedby={`${id}-desc`} onChange={() => setAccess(access)} />
              <div className={styles.text}>
                <label htmlFor={id} className={styles.label}>{AGENT_ACCESS_INFO[access].label}{access === "propose" ? <span className={styles.act}>Can act</span> : <span className={styles.readTag}>Read</span>}</label>
                <p id={`${id}-desc`} className={styles.description}>{AGENT_ACCESS_INFO[access].description}</p>
              </div>
            </div>;
          })}
        </div>
        {draft.agent.access === "propose" ? <div className={styles.sub}>
          <p className={styles.subTitle}>Auto mode to suggest for new connections</p>
          <p className={styles.description}>These are only preselected. Auto mode stays off until you turn it on for a specific connection.</p>
          <ul className={styles.list}>
            {AUTO_CATEGORIES.map((category) => {
              const id = `${ids}-auto-${category}`;
              return <li key={category} className={styles.row}>
                <input id={id} type="checkbox" className={styles.check} checked={draft.agent.autoCategories.includes(category)}
                  aria-describedby={`${id}-desc`} onChange={(event) => toggleCategory(category, event.target.checked)} />
                <div className={styles.text}>
                  <label htmlFor={id} className={styles.label}>{CATEGORY_INFO[category].label}</label>
                  <p id={`${id}-desc`} className={styles.description}>{CATEGORY_INFO[category].description}</p>
                </div>
              </li>;
            })}
          </ul>
        </div> : null}
        <p className={styles.note}>Existing connections keep their current permissions. Change those under Agents (MCP).</p>
      </fieldset>

      <div className={styles.footer}>
        <button type="submit" className="button primary" disabled={!dirty || save.state === "saving"} aria-describedby={`${ids}-save-status`}>
          {save.state === "saving" ? "Saving…" : "Save changes"}
        </button>
        <p id={`${ids}-save-status`} className={save.state === "error" ? styles.error : styles.muted} role={save.state === "error" ? "alert" : "status"}>
          {save.state === "error" ? save.message
            : save.state === "saved" ? `Saved. ${savedLabel(load.saved.savedAt)}`
            : dirty ? "You have unsaved changes." : `No changes to save. ${savedLabel(load.saved.savedAt)}`}
        </p>
      </div>
    </form> : null}
  </section>;
}
