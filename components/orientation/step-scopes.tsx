"use client";

import { useId, useState } from "react";
import type { UiError } from "@/components/ui/ui-errors";
import { AGENT_ACCESS, AGENT_ACCESS_INFO, DATA_SCOPE_INFO, NEVER_ACCESSED, type AgentAccess, type DataScope, type ScopeSettings } from "@/lib/scopes/catalog";
import { AUTO_CATEGORIES, CATEGORY_INFO, type AutoCategory } from "@/lib/mcp/categories";
import { hostOf, type School } from "./model";
import { Callout, Mono, StepFooter, StepHeader } from "./shell";
import styles from "./orientation.module.css";

/** Grouped by what the user gets, not by API area. Labels and descriptions come from the catalog. */
const GROUPS: Array<{ title: string; scopes: DataScope[] }> = [
  { title: "Plan your coursework", scopes: ["courses", "assignments", "quizzes", "grades"] },
  { title: "Keep up with your classes", scopes: ["announcements", "inbox"] },
  { title: "Study course material", scopes: ["content"] },
];

export type ScopesLoad = { status: "loading" | "ready" | "error"; message?: string };

/** Step 4: a consent screen. Who is asking, for which Canvas host, what, and what never. */
export function StepScopes({ school, accountName, draft, onChange, load, onRetryLoad, saving, saveError, onSave, onBack }: {
  school: School | null;
  accountName?: string | null;
  draft: ScopeSettings;
  onChange: (next: ScopeSettings) => void;
  load: ScopesLoad;
  onRetryLoad: () => void;
  saving: boolean;
  saveError: UiError | null;
  onSave: () => void;
  onBack: () => void;
}) {
  const host = hostOf(school?.domain);
  const toggle = (scope: DataScope) => onChange({ ...draft, data: draft.data.includes(scope) ? draft.data.filter((item) => item !== scope) : [...draft.data, scope] });
  const setAccess = (access: AgentAccess) => onChange({ ...draft, agent: { ...draft.agent, access } });
  const toggleCategory = (category: AutoCategory) => onChange({ ...draft, agent: { ...draft.agent, autoCategories: draft.agent.autoCategories.includes(category) ? draft.agent.autoCategories.filter((item) => item !== category) : [...draft.agent.autoCategories, category] } });
  const enabledCount = draft.data.length;

  return <>
    <StepHeader title="Choose what Grove can read">
      Canvas Grove is asking to read from {school ? `${school.name} Canvas` : "your Canvas"}{accountName ? ` as ${accountName}` : ""}. You can change this later in Settings.
    </StepHeader>
    {host ? <p className={styles.requester}><span className={styles.requesterLabel}>Canvas site</span><Mono>{host}</Mono></p> : null}

    {load.status === "error" ? <Callout tone="warning" title="Your saved choices did not load" action={<button type="button" className="button secondary" onClick={onRetryLoad}>Load again</button>}>
      <p>The defaults are shown below. Saving them replaces whatever was stored before.</p>
    </Callout> : null}

    <fieldset className={styles.section} disabled={load.status === "loading" || saving} aria-busy={load.status === "loading" || undefined}>
      <legend className={styles.sectionTitle}>Canvas data <span className={styles.tag} data-kind="read">Read only</span></legend>
      <p className={styles.sectionNote}>Grove syncs these areas. It never changes anything in Canvas on its own.</p>
      {GROUPS.map((group) => <div key={group.title} className={styles.group}>
        <h3 className={styles.groupTitle}>{group.title}</h3>
        <ul className={styles.scopeList}>
          {group.scopes.map((scope) => <ScopeRow key={scope} scope={scope} checked={draft.data.includes(scope)} onToggle={() => toggle(scope)} />)}
        </ul>
      </div>)}
      <p className={styles.fieldHelp} aria-live="polite">{enabledCount} of {Object.keys(DATA_SCOPE_INFO).length} areas allowed.</p>
    </fieldset>

    <fieldset className={styles.section} disabled={load.status === "loading" || saving}>
      <legend className={styles.sectionTitle}>Connected AI agents</legend>
      <p className={styles.sectionNote}>The default for agents you connect later, such as Claude or Cursor. Agents only see the areas allowed above.</p>
      <ul className={styles.scopeList}>
        {AGENT_ACCESS.map((access) => <li key={access} className={styles.choiceRow}>
          <label className={styles.choice}>
            <input type="radio" name="orientation-agent-access" value={access} checked={draft.agent.access === access} onChange={() => setAccess(access)} />
            <span className={styles.scopeText}>
              <span className={styles.scopeLabel}>{AGENT_ACCESS_INFO[access].label}<span className={styles.tag} data-kind={access === "read" ? "read" : "act"}>{access === "read" ? "Read" : "Can act"}</span></span>
              <span className={styles.scopeDescription}>{AGENT_ACCESS_INFO[access].description}</span>
            </span>
          </label>
        </li>)}
      </ul>
      {draft.agent.access === "propose" ? <details className={styles.autoDefaults} open={draft.agent.autoCategories.length > 0 || undefined}>
        <summary>Auto mode defaults <span className={styles.summaryHint}>{draft.agent.autoCategories.length ? `${draft.agent.autoCategories.length} preselected` : "None preselected"}</span></summary>
        <p className={styles.fieldHelp}>These are preselected when you set up auto mode for a new connection. Auto mode stays off until you turn it on for that connection.</p>
        <ul className={styles.checkList}>
          {AUTO_CATEGORIES.map((category) => <li key={category}>
            <label className={styles.choice}>
              <input type="checkbox" checked={draft.agent.autoCategories.includes(category)} onChange={() => toggleCategory(category)} />
              <span className={styles.scopeText}>
                <span className={styles.scopeLabel}>{CATEGORY_INFO[category].label}</span>
                <span className={styles.scopeDescription}>{CATEGORY_INFO[category].description}</span>
              </span>
            </label>
          </li>)}
        </ul>
      </details> : null}
    </fieldset>

    <section className={styles.section} aria-labelledby="orientation-never">
      <h2 id="orientation-never" className={styles.sectionTitle}>Grove never reads</h2>
      <ul className={styles.neverList}>{NEVER_ACCESSED.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>

    {saveError ? <Callout tone="danger" title={saveError.title}>
      <p>{saveError.message} {saveError.nextAction}</p>
    </Callout> : null}

    <StepFooter
      onBack={onBack}
      primary={{ label: "Allow and continue", onClick: onSave, disabled: load.status === "loading", busy: saving, busyLabel: "Saving…" }}
      helper={load.status === "loading" ? "Loading your saved choices…" : undefined}
    />
  </>;
}

function ScopeRow({ scope, checked, onToggle }: { scope: DataScope; checked: boolean; onToggle: () => void }) {
  const info = DATA_SCOPE_INFO[scope];
  const [open, setOpen] = useState(false);
  const id = useId();
  const required = Boolean(info.required);
  return <li className={styles.scopeRow}>
    <label className={styles.choice}>
      <input type="checkbox" checked={required || checked} disabled={required} aria-describedby={`${id}-desc`} onChange={onToggle} />
      <span className={styles.scopeText}>
        <span className={styles.scopeLabel}>{info.label}{required ? <span className={styles.tag} data-kind="required">Required</span> : null}</span>
        <span id={`${id}-desc`} className={styles.scopeDescription}>{info.description}</span>
      </span>
    </label>
    <button type="button" className={styles.detailToggle} aria-expanded={open} aria-controls={`${id}-detail`} onClick={() => setOpen((value) => !value)}>
      {open ? "Less" : "More"}<span className="sr-only"> about {info.label}</span>
    </button>
    <p id={`${id}-detail`} className={styles.scopeDetail} hidden={!open}>{info.detail}</p>
  </li>;
}
