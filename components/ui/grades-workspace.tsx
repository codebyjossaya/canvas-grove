"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { calculateGrade, type GradeAssignment, type GradeGroup } from "@/lib/grades/engine";
import { formatInstant } from "@/lib/time";
import { Icon } from "./icons";
import styles from "./grades-workspace.module.css";
import { useDisplayTimeZone } from "./use-display-timezone";

type Assignment = { id: string; canvasId?: string; name: string; groupId: string | null; dueAt: string | null; pointsPossible: number | null; score: number | null; grade: string | null; status: string; excused: boolean; missing: boolean; late: boolean; omitted: boolean; extraCredit: boolean };
type Group = { id: string; name: string; weight: number | null; earned: number; possible: number; percent: number | null; droppedAssignmentIds: string[]; dropRules?: { dropLowest: number; dropHighest: number; neverDropCanvasIds: string[] } };
type GradeCourse = { course: { id: string; name: string; courseCode?: string | null }; summary: { currentPercent: number | null; projectedPercent: number | null; maximumPercent: number | null; schemeLabel?: string | null; weighted: boolean }; groups: Group[]; assignments: Assignment[] };
type Scenario = { id: string; name: string; hypotheticalScores: Record<string, number | null>; updatedAt?: string | null };
type GradeResponse = { courses?: GradeCourse[]; lastSyncedAt?: string | null; stale?: boolean; error?: string };
type AssignmentFilter = "all" | "remaining" | "graded" | "attention";
type Scores = Record<string, number | null>;

const storageKey = (courseId: string) => `cg-whatif:${courseId}`;

export function GradesWorkspace({ courseId, embedded = false }: { courseId: string; embedded?: boolean }) {
  const timeZone = useDisplayTimeZone();
  const [courses, setCourses] = useState<GradeCourse[]>([]);
  const [scores, setScores] = useState<Scores>({});
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioName, setScenarioName] = useState("What-If scenario");
  const [filter, setFilter] = useState<AssignmentFilter>("all");
  const [limit, setLimit] = useState(40);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState("90");
  const [solveFor, setSolveFor] = useState<string | "all">("all");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/canvas/grades?courseId=${encodeURIComponent(courseId)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      const value = await response.json() as GradeResponse;
      if (!response.ok) throw new Error(value.error || "Grades are unavailable");
      const next = value.courses ?? [];
      setCourses(next);
      setLastSyncedAt(value.lastSyncedAt ?? null);
      setStale(Boolean(value.stale));
      // What-If entries persist only in this browser, keyed by course; stale ids are ignored.
      try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey(courseId)) ?? "{}") as Scores;
        const ids = new Set((next[0]?.assignments ?? []).map(item => item.id));
        setScores(Object.fromEntries(Object.entries(saved).filter(([id, score]) => ids.has(id) && (score === null || Number.isFinite(score)))));
      } catch { setScores({}); }
    } catch (reason) {
      setError(reason instanceof DOMException && reason.name === "TimeoutError" ? "Saved grades took too long to load. Try again without changing Canvas." : "Grades could not be loaded. Canvas grades are unchanged.");
    } finally { setLoading(false); }
  }, [courseId]);

  const loadScenarios = useCallback(async (selectedId: string) => {
    if (!selectedId) { setScenarios([]); return; }
    try {
      const response = await fetch(`/api/canvas/grades/scenarios?courseId=${encodeURIComponent(selectedId)}`, { cache: "no-store" });
      const value = await response.json() as { scenarios?: Scenario[] };
      setScenarios(response.ok ? value.scenarios ?? [] : []);
    } catch { setScenarios([]); }
  }, []);

  useEffect(() => { const start = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(start); }, [load]);
  useEffect(() => { const start = window.setTimeout(() => void loadScenarios(courseId), 0); return () => window.clearTimeout(start); }, [courseId, loadScenarios]);

  function update(next: Scores) {
    setScores(next); setNotice("");
    try { if (Object.keys(next).length) window.localStorage.setItem(storageKey(courseId), JSON.stringify(next)); else window.localStorage.removeItem(storageKey(courseId)); } catch { /* storage may be unavailable */ }
  }

  const selected = courses[0];
  const baseline = useMemo(() => calculate(selected, {}), [selected]);
  const hypothetical = useMemo(() => calculate(selected, scores), [scores, selected]);
  const changed = Object.keys(scores).length;
  const matches = useCallback((item: Assignment) => filter === "all" || (filter === "remaining" && item.score == null && !item.excused && !item.omitted) || (filter === "graded" && item.score != null) || (filter === "attention" && (item.missing || item.late)), [filter]);
  const filtered = useMemo(() => (selected?.assignments ?? []).filter(matches).sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999")), [matches, selected]);
  const remaining = useMemo(() => (selected?.assignments ?? []).filter(item => item.score == null && !item.excused && !item.omitted && (item.pointsPossible ?? 0) > 0 && !Object.prototype.hasOwnProperty.call(scores, item.id)), [scores, selected]);
  // Canvas is the official number; the engine contributes only the change, so a blank What-If
  // always equals the Canvas grade even if Canvas applies rules the cached data cannot see.
  const offset = selected?.summary.currentPercent != null && baseline.percent != null ? selected.summary.currentPercent - baseline.percent : 0;
  const solution = useMemo(() => solve(selected, scores, Number(target) - offset, solveFor === "all" ? remaining : remaining.filter(item => item.id === solveFor)), [offset, remaining, scores, selected, solveFor, target]);

  function reset() { update({}); setNotice("What-If cleared. Showing your Canvas grade."); }
  async function save() {
    if (!selected || !changed || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/canvas/grades/scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courseId: selected.course.id, name: scenarioName.trim() || "What-If scenario", scores }) });
      const value = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(value.error || "Scenario could not be saved");
      await loadScenarios(selected.course.id);
      setNotice("Scenario saved privately in Canvas Grove.");
    } catch { setError("The scenario could not be saved. Your What-If entries are still on this page, and Canvas was not changed."); }
    finally { setSaving(false); }
  }
  function applyScenario(scenario: Scenario) { update(scenario.hypotheticalScores ?? {}); setScenarioName(scenario.name); setNotice(`Loaded “${scenario.name}”. Canvas is unchanged.`); }

  const className = `${styles.wrap} ${embedded ? styles.embedded : ""}`;
  if (loading && !courses.length) return <div className={className}><WorkspaceSkeleton /></div>;
  if (error && !courses.length) return <div className={className}><State title="Grades are unavailable" body={error}><button className="button secondary" onClick={() => void load()}>Try again</button></State></div>;
  if (!selected) return <div className={className}><State title="No course grades yet" body="Posted assignments for this course will appear after a successful Canvas sync." /></div>;

  const canvasPercent = selected.summary.currentPercent;
  const delta = changed && hypothetical.percent != null && baseline.percent != null ? hypothetical.percent - baseline.percent : 0;
  const whatIf = !changed ? canvasPercent : canvasPercent != null ? canvasPercent + delta : hypothetical.percent;
  const groups = hypothetical.groups.filter(group => group.id !== "ungrouped" || group.possible > 0 || selected.assignments.some(item => item.groupId === null));
  const totalWeight = groups.reduce((sum, group) => sum + (group.weight ?? 0), 0);

  return <div className={className}>
    {!embedded && <header className={styles.head}><p className="eyebrow">{selected.course.courseCode || "Course grades"}</p><h1>{selected.course.name}</h1></header>}
    <section className={styles.summary} aria-label="Grade outcomes">
      <div className={styles.metric}><span>Canvas grade</span><strong className="num">{percent(canvasPercent)}</strong><small>{selected.summary.schemeLabel ? `${selected.summary.schemeLabel} · ` : ""}<span className={`${styles.freshness} ${stale ? styles.stale : ""}`}>{lastSyncedAt ? `${stale ? "last synced" : "synced"} ${relative(lastSyncedAt, timeZone)}` : "waiting for sync"}</span></small></div>
      <div className={`${styles.metric} ${styles.emphasized}`}><span>What-If</span><strong className="num">{percent(whatIf)}</strong><small>{changed ? <><b className={delta >= 0 ? styles.up : styles.down}>{delta >= 0 ? "+" : ""}{delta.toFixed(2)}</b> from {changed} {changed === 1 ? "change" : "changes"}</> : "Edit any score below to explore"}</small></div>
      <div className={styles.metric}><span>Method</span><strong>{selected.summary.weighted ? "Weighted" : "Total points"}</strong><small>{selected.summary.weighted ? `${groups.length} assignment groups` : `${fmt(hypothetical.earned)} / ${fmt(hypothetical.possible)} pts counted`}</small></div>
    </section>

    <div className={styles.columns}>
      <section className={styles.groups} aria-labelledby="group-breakdown">
        <h2 id="group-breakdown" className="section-title">Assignment groups</h2>
        <ul>{groups.map(group => {
          const share = selected.summary.weighted && totalWeight > 0 ? (group.weight ?? 0) / totalWeight * 100 : null;
          const rules = selected.groups.find(item => item.id === group.id)?.dropRules;
          return <li key={group.id}>
            <div className={styles.groupTop}><strong>{group.name}</strong>{share != null && <span className="num">{fmt(group.weight ?? 0)}%</span>}</div>
            <div className={styles.meter} aria-hidden="true"><i style={{ width: `${Math.min(100, group.percent ?? 0)}%` }} /></div>
            <div className={styles.groupBottom}><span className="num">{group.percent == null ? "No graded work" : `${group.percent.toFixed(1)}%`}</span><span className="num">{fmt(group.earned)} / {fmt(group.possible)}</span></div>
            {(rules?.dropLowest || rules?.dropHighest) ? <small className={styles.rule}>{rules.dropLowest ? `Drops lowest ${rules.dropLowest}` : ""}{rules.dropLowest && rules.dropHighest ? " · " : ""}{rules.dropHighest ? `drops highest ${rules.dropHighest}` : ""}</small> : null}
          </li>;
        })}</ul>
      </section>

      <section className={styles.solver} aria-labelledby="solver-title">
        <h2 id="solver-title" className="section-title">What do I need?</h2>
        <div className={styles.solverCard}>
          <label className={styles.target}>To finish at <span className={styles.targetInput}><input type="number" inputMode="decimal" min="0" max="150" step="0.5" value={target} onChange={event => setTarget(event.target.value)} aria-label="Target course percentage" /><span>%</span></span></label>
          <div className={styles.solveFor} role="radiogroup" aria-label="Solve for">
            <button role="radio" aria-checked={solveFor === "all"} onClick={() => setSolveFor("all")}>Across all remaining ({remaining.length})</button>
            {solveFor !== "all" && remaining.some(item => item.id === solveFor) && <button role="radio" aria-checked="true">{remaining.find(item => item.id === solveFor)?.name}</button>}
          </div>
          <p className={styles.answer} role="status" aria-live="polite">{solutionText(solution, solveFor === "all" ? remaining.length : 1)}</p>
          <small>Tip: choose “Need” on any ungraded row to solve for that one assignment. Uses posted scores plus your What-If entries.</small>
        </div>
      </section>
    </div>

    <div className={styles.toolbar}>
      <h2>Assignments <span className="count">{selected.assignments.length}</span></h2>
      <div className={styles.filters} role="group" aria-label="Filter assignments">{(["all", "remaining", "graded", "attention"] as AssignmentFilter[]).map(value => <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(40); }}>{value === "attention" ? "Needs attention" : title(value)}</button>)}</div>
    </div>
    <div className={styles.table} role="table" aria-label="What-If gradebook">
      <div className={styles.tableHead} role="row"><span role="columnheader">Assignment</span><span role="columnheader">Status</span><span role="columnheader">Canvas</span><span role="columnheader">What-If</span></div>
      <div className={styles.rows} role="rowgroup">{filtered.length ? filtered.slice(0, limit).map(item => <AssignmentRow key={item.id} item={item} group={selected.groups.find(group => group.id === item.groupId)?.name ?? null} dropped={(changed ? hypothetical.groups : selected.groups).some(group => group.droppedAssignmentIds.includes(item.id))} value={scores[item.id]} changed={Object.prototype.hasOwnProperty.call(scores, item.id)} solving={solveFor === item.id} timeZone={timeZone} update={value => update({ ...scores, [item.id]: value })} clear={() => { const next = { ...scores }; delete next[item.id]; update(next); }} solve={() => setSolveFor(item.id)} />) : <div className={styles.emptyRow}>No assignments match this filter.</div>}</div>
      {filtered.length > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 40)}>Show more assignments</button>}
    </div>

    <section className={styles.scenarioBar} aria-label="What-If scenarios">
      <div className={styles.scenarioActions}>
        <label><span className="sr-only">Scenario name</span><input value={scenarioName} maxLength={120} onChange={event => setScenarioName(event.target.value)} /></label>
        <button className="button secondary" disabled={!changed || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save scenario"}</button>
        <button className="button ghost" disabled={!changed} onClick={reset}>Reset to Canvas</button>
      </div>
      {scenarios.length > 0 && <div className={styles.savedScenarios}><span>Saved</span>{scenarios.slice(0, 6).map(scenario => <button key={scenario.id} onClick={() => applyScenario(scenario)}>{scenario.name}</button>)}</div>}
    </section>
    {error && <p className={styles.alert} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <p className={styles.note}><Icon name="lock" /><span><strong>Private.</strong> What-If entries stay in this browser (saved scenarios stay in Canvas Grove) and never change Canvas. Canvas remains the official grade.</span></p>
  </div>;
}

function AssignmentRow({ item, group, dropped, value, changed, solving, timeZone, update, clear, solve }: { item: Assignment; group: string | null; dropped: boolean; value: number | null | undefined; changed: boolean; solving: boolean; timeZone: string; update: (value: number | null) => void; clear: () => void; solve: () => void }) {
  const status = dropped ? "Dropped" : item.excused ? "Excused" : item.omitted ? "Omitted" : item.missing ? "Missing" : item.late ? "Late" : item.score == null ? "Not graded" : "Graded";
  const tone = item.missing ? "danger" : item.late ? "warning" : item.score != null && !dropped ? "success" : "";
  const solvable = item.score == null && !item.excused && !item.omitted && !changed && (item.pointsPossible ?? 0) > 0;
  return <div className={`${styles.row} ${changed ? styles.changed : ""} ${solving ? styles.solving : ""}`} role="row">
    <div role="cell" className={styles.nameCell}><strong>{item.name}</strong><small>{[group, item.pointsPossible == null ? "Points not set" : `${fmt(item.pointsPossible)} pts`, item.dueAt ? date(item.dueAt, timeZone) : "No due date"].filter(Boolean).join(" · ")}</small></div>
    <div role="cell"><span className={`chip ${tone}`}>{status}</span></div>
    <div role="cell" className={styles.score}><strong className="num">{item.score == null ? "—" : fmt(item.score)}</strong>{item.pointsPossible != null && item.score != null && <small className="num">/ {fmt(item.pointsPossible)}</small>}</div>
    <div role="cell" className={styles.whatIf}>
      <label><span className="sr-only">Hypothetical score for {item.name}</span><input type="number" inputMode="decimal" min="0" max={item.extraCredit || item.pointsPossible == null ? undefined : item.pointsPossible * 1.5} step="0.5" value={changed ? value ?? "" : ""} placeholder={item.score == null ? "—" : fmt(item.score)} onChange={event => event.target.value === "" ? clear() : update(Number(event.target.value))} /></label>
      {changed ? <button className={styles.rowAction} onClick={clear} aria-label={`Clear What-If for ${item.name}`} title="Clear"><Icon name="x" /></button> : solvable ? <button className={styles.rowAction} onClick={solve} aria-pressed={solving} title="What do I need on this?">Need</button> : <span className={styles.rowAction} aria-hidden="true" />}
    </div>
  </div>;
}

function WorkspaceSkeleton() { return <div className={styles.skeleton} role="status"><span className="sr-only">Loading saved grades</span><div>{[0, 1, 2].map(index => <i key={index} className="skeleton" />)}</div>{[0, 1, 2, 3, 4].map(index => <i key={index} className="skeleton" />)}</div>; }
function State({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) { return <div className="empty-state" role="status"><span className="empty-icon"><Icon name="grade" /></span><h3>{title}</h3><p>{body}</p>{children && <div className="actions">{children}</div>}</div>; }

function engineInputs(course: GradeCourse, scores: Scores) {
  const groups: GradeGroup[] = course.groups.map(group => ({ id: group.id, name: group.name, weight: group.weight ?? 0, dropLowest: group.dropRules?.dropLowest ?? 0, dropHighest: group.dropRules?.dropHighest ?? 0, neverDropCanvasIds: group.dropRules?.neverDropCanvasIds ?? [] }));
  if (course.assignments.some(item => !item.groupId) && !groups.some(group => group.id === "ungrouped")) groups.push({ id: "ungrouped", name: "Assignments", weight: 0, dropLowest: 0, dropHighest: 0, neverDropCanvasIds: [] });
  // Excused and omitted work never counts; everything else counts once it has a real or What-If score.
  const assignments: GradeAssignment[] = course.assignments.filter(item => !item.excused && !item.omitted).map(item => ({
    id: item.id, canvasId: item.canvasId ?? item.id, groupId: item.groupId ?? "ungrouped", pointsPossible: item.pointsPossible == null ? null : item.pointsPossible,
    score: item.score, excused: false, omitted: false, ungraded: item.score == null && !(Object.prototype.hasOwnProperty.call(scores, item.id) && scores[item.id] != null), extraCredit: item.extraCredit,
  }));
  return { groups, assignments };
}

/** The same engine as the server summary, so a blank What-If equals the synced calculation. */
function calculate(course: GradeCourse | undefined, scores: Scores) {
  if (!course) return { percent: null, earned: 0, possible: 0, groups: [] as Array<Group & { weight: number }> };
  const { groups, assignments } = engineInputs(course, scores);
  const result = calculateGrade({ weighted: course.summary.weighted, groups, assignments, hypothetical: scores });
  return { ...result, groups: result.groups.map(group => ({ ...group, weight: group.weight })) };
}

type Solution = { kind: "none" } | { kind: "secured" } | { kind: "unreachable"; best: number | null } | { kind: "need"; fraction: number; points: number | null };

/** Smallest uniform score fraction on the chosen remaining work that reaches the target. */
function solve(course: GradeCourse | undefined, scores: Scores, target: number, pool: Assignment[]): Solution {
  if (!course || !pool.length || !Number.isFinite(target)) return { kind: "none" };
  const outcome = (fraction: number) => calculate(course, { ...scores, ...Object.fromEntries(pool.map(item => [item.id, (item.pointsPossible ?? 0) * fraction])) }).percent ?? 0;
  if (outcome(0) >= target) return { kind: "secured" };
  if (outcome(1) < target) return { kind: "unreachable", best: outcome(1) };
  let low = 0, high = 1;
  for (let step = 0; step < 40; step++) { const mid = (low + high) / 2; if (outcome(mid) >= target) high = mid; else low = mid; }
  return { kind: "need", fraction: high, points: pool.length === 1 ? (pool[0].pointsPossible ?? 0) * high : null };
}

function solutionText(solution: Solution, count: number) {
  if (solution.kind === "none") return count ? "Enter a target percentage." : "Nothing left to grade. Your grade depends only on posted work.";
  if (solution.kind === "secured") return "You’re already there, even with zeros on the remaining work.";
  if (solution.kind === "unreachable") return `Not reachable with full marks on ${count === 1 ? "it" : "the remaining work"}.`;
  const pct = `${(solution.fraction * 100).toFixed(1)}%`;
  return solution.points != null ? `You need at least ${fmt(Math.ceil(solution.points * 10) / 10)} points (${pct}) on it.` : `You need an average of ${pct} across the ${count} remaining ${count === 1 ? "assignment" : "assignments"}.`;
}

function percent(value: number | null | undefined) { return value == null ? "—" : `${value.toFixed(1)}%`; }
function date(value: string, zone: string) { return formatInstant(value, zone, { month: "short", day: "numeric" }); }
function relative(value: string, zone: string) { const delta = Math.max(0, Date.now() - new Date(value).getTime()); if (delta < 60_000) return "just now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return date(value, zone); }
function fmt(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function title(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
