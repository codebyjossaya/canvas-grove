"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatInstant } from "@/lib/time";
import styles from "./grades-workspace.module.css";
import { useDisplayTimeZone } from "./use-display-timezone";

type Assignment = { id: string; name: string; groupId: string | null; dueAt: string | null; pointsPossible: number | null; score: number | null; grade: string | null; status: string; excused: boolean; missing: boolean; late: boolean; omitted: boolean; extraCredit: boolean };
type Group = { id: string; name: string; weight: number | null; earned: number; possible: number; percent: number | null; droppedAssignmentIds: string[] };
type GradeCourse = { course: { id: string; name: string; courseCode?: string | null }; summary: { currentPercent: number | null; projectedPercent: number | null; maximumPercent: number | null; schemeLabel?: string | null; weighted: boolean }; groups: Group[]; assignments: Assignment[] };
type Scenario = { id: string; name: string; hypotheticalScores: Record<string, number | null>; updatedAt?: string | null };
type GradeResponse = { courses?: GradeCourse[]; lastSyncedAt?: string | null; stale?: boolean; error?: string };
type AssignmentFilter = "all" | "remaining" | "graded" | "attention";

export function GradesWorkspace({ courseId, embedded = false }: { courseId: string; embedded?: boolean }) {
  const timeZone = useDisplayTimeZone();
  const [courses, setCourses] = useState<GradeCourse[]>([]);
  const [scores, setScores] = useState<Record<string, number | null>>({});
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioName, setScenarioName] = useState("What-If scenario");
  const [filter, setFilter] = useState<AssignmentFilter>("all");
  const [limit, setLimit] = useState(24);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

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
  useEffect(() => {
    const start = window.setTimeout(() => void loadScenarios(courseId), 0);
    return () => window.clearTimeout(start);
  }, [courseId, loadScenarios]);
  const selected = courses[0];
  const hypothetical = useMemo(() => calculate(selected, scores), [scores, selected]);
  const changed = Object.keys(scores).length;
  const visible = useMemo(() => (selected?.assignments ?? []).filter(item => filter === "all" || (filter === "remaining" && item.score == null && !item.excused && !item.omitted) || (filter === "graded" && item.score != null) || (filter === "attention" && (item.missing || item.late))).slice(0, limit), [filter, limit, selected]);

  function reset() { setScores({}); setNotice(""); }
  async function save() {
    if (!selected || !changed || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/canvas/grades/scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courseId: selected.course.id, name: scenarioName.trim() || "What-If scenario", scores }) });
      const value = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(value.error || "Scenario could not be saved");
      await loadScenarios(selected.course.id);
      setNotice("Scenario saved privately in Canvas Grove.");
    } catch { setError("The scenario could not be saved. Your local What-If entries are still on this page, and Canvas was not changed."); }
    finally { setSaving(false); }
  }
  function applyScenario(scenario: Scenario) { setScores(scenario.hypotheticalScores ?? {}); setScenarioName(scenario.name); setNotice(`Loaded “${scenario.name}”. Canvas is unchanged.`); }

  const className = `${styles.wrap} ${embedded ? styles.embedded : ""}`;
  if (loading) return <main className={className}><WorkspaceSkeleton /></main>;
  if (error && !courses.length) return <main className={className}><State title="Grades are unavailable" body={error}><button className="button secondary" onClick={() => void load()}>Try again</button></State></main>;
  if (!selected) return <main className={className}><State title="No course grades yet" body="Posted assignments for this course will appear after a successful Canvas sync." /></main>;

  const filteredCount = (selected.assignments ?? []).filter(item => filter === "all" || (filter === "remaining" && item.score == null && !item.excused && !item.omitted) || (filter === "graded" && item.score != null) || (filter === "attention" && (item.missing || item.late))).length;
  return <main className={className}>
    <header className={styles.head}>
      <div><p className="eyebrow">{selected.course.courseCode || "Course grades"}</p><h1>Grades &amp; What-If</h1><p>{selected.course.name}. Explore private hypothetical scores without changing Canvas.</p></div>
      <div className={styles.headControls}><span className={`${styles.freshness} ${stale ? styles.stale : ""}`}><i aria-hidden="true" />{lastSyncedAt ? `${stale ? "Last synced" : "Updated"} ${relative(lastSyncedAt, timeZone)}` : "Waiting for sync"}</span></div>
    </header>

    <section className={styles.summary} aria-label="Grade outcomes">
      <Metric label="Canvas baseline" value={percent(selected.summary.currentPercent)} detail={selected.summary.schemeLabel || "Current posted work"} />
      <Metric label="What-If outcome" value={percent(hypothetical)} detail={changed ? `${changed} local ${changed === 1 ? "change" : "changes"}` : "Matches baseline"} emphasized />
      <Metric label="Course method" value={selected.summary.weighted ? "Weighted" : "Points"} detail={selected.summary.maximumPercent == null ? "Maximum not reported" : `Maximum ${percent(selected.summary.maximumPercent)}`} />
    </section>

    <section className={styles.scenarioBar} aria-label="What-If scenarios">
      <div><label>Scenario name<input value={scenarioName} maxLength={120} onChange={event => setScenarioName(event.target.value)} /></label><button className="button primary" disabled={!changed || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save scenario"}</button><button className="button secondary" disabled={!changed} onClick={reset}>Reset</button></div>
      {scenarios.length > 0 && <div className={styles.savedScenarios}><span>Saved</span>{scenarios.slice(0, 5).map(scenario => <button key={scenario.id} onClick={() => applyScenario(scenario)}>{scenario.name}</button>)}</div>}
    </section>
    {error && <p className={styles.alert} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}

    <div className={styles.toolbar}><div><h2>Assignments</h2><p>{filteredCount} shown · {selected.assignments.length} total</p></div><div className={styles.filters} role="group" aria-label="Filter assignments">{(["all", "remaining", "graded", "attention"] as AssignmentFilter[]).map(value => <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(24); }}>{value === "attention" ? "Needs attention" : title(value)}</button>)}</div></div>

    <div className={styles.table} role="table" aria-label="What-If gradebook">
      <div className={styles.tableHead} role="row"><span role="columnheader">Assignment</span><span role="columnheader">Status</span><span role="columnheader">Canvas</span><span role="columnheader">What-If</span></div>
      <div className={styles.rows} role="rowgroup">{visible.length ? visible.map(item => <AssignmentRow key={item.id} item={item} dropped={selected.groups.some(group => group.droppedAssignmentIds.includes(item.id))} value={scores[item.id]} changed={Object.prototype.hasOwnProperty.call(scores, item.id)} timeZone={timeZone} update={value => setScores(old => ({ ...old, [item.id]: value }))} />) : <div className={styles.emptyRow}>No assignments match this filter.</div>}</div>
      {filteredCount > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 24)}>Show more assignments</button>}
      <div className={styles.groups}>{selected.groups.map(group => <div className={styles.group} key={group.id}><span><strong>{group.name}</strong>{group.weight != null && <small>{group.weight}% of course</small>}</span><span><strong>{percent(group.percent)}</strong><small>{formatPoints(group.earned)} / {formatPoints(group.possible)}</small></span></div>)}</div>
    </div>
    <p className={styles.note}><strong>Private playground.</strong> What-If scores and saved scenarios stay in Canvas Grove and never change Canvas. Reset returns every field to the posted baseline.</p>
  </main>;
}

function AssignmentRow({ item, dropped, value, changed, timeZone, update }: { item: Assignment; dropped: boolean; value: number | null | undefined; changed: boolean; timeZone: string; update: (value: number | null) => void }) {
  const status = dropped ? "Dropped" : item.excused ? "Excused" : item.omitted ? "Omitted" : item.missing ? "Missing" : item.late ? "Late" : item.score == null ? "Not graded" : "Graded";
  return <div className={`${styles.row} ${changed ? styles.changed : ""}`} role="row">
    <div role="cell"><strong>{item.name}</strong><small>{[item.pointsPossible == null ? "Points not set" : `${item.pointsPossible} points`, item.dueAt ? date(item.dueAt, timeZone) : "No due date"].join(" · ")}</small></div>
    <div role="cell"><span className={`${styles.status} ${item.missing || item.late ? styles.attention : ""}`}>{status}</span></div>
    <div role="cell" className={styles.score}><strong>{item.score == null ? "—" : item.score}</strong>{item.grade && <small>{item.grade}</small>}</div>
    <div role="cell"><label><span className="sr-only">Hypothetical score for {item.name}</span><input type="number" inputMode="decimal" min="0" max={item.extraCredit || item.pointsPossible == null ? undefined : item.pointsPossible} value={changed ? value ?? "" : ""} placeholder={item.score == null ? "—" : String(item.score)} onChange={event => update(event.target.value === "" ? null : Number(event.target.value))} /></label></div>
  </div>;
}

function Metric({ label, value, detail, emphasized }: { label: string; value: string; detail: string; emphasized?: boolean }) { return <div className={`${styles.metric} ${emphasized ? styles.emphasized : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function WorkspaceSkeleton() { return <div className={styles.skeleton} role="status"><span className="sr-only">Loading saved grades</span><i /><div><i /><i /><i /></div><i /><i /><i /></div>; }
function State({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) { return <div className={styles.state} role="status"><span aria-hidden="true">%</span><strong>{title}</strong><p>{body}</p>{children}</div>; }

function calculate(course: GradeCourse | undefined, scores: Record<string, number | null>) {
  if (!course) return null;
  const usable = course.assignments.filter(item => !item.excused && !item.omitted);
  const score = (item: Assignment) => Object.prototype.hasOwnProperty.call(scores, item.id) ? scores[item.id] : item.score;
  if (course.summary.weighted) {
    let total = 0, weight = 0;
    for (const group of course.groups) {
      const assignments = usable.filter(item => item.groupId === group.id && !group.droppedAssignmentIds.includes(item.id));
      const possible = assignments.reduce((sum, item) => score(item) == null || item.pointsPossible == null ? sum : sum + item.pointsPossible, 0);
      const earned = assignments.reduce((sum, item) => sum + (score(item) ?? 0), 0);
      const groupWeight = group.weight ?? 0;
      if (possible > 0 && groupWeight > 0) { total += earned / possible * groupWeight; weight += groupWeight; }
    }
    return weight > 0 ? total / weight * 100 : course.summary.currentPercent;
  }
  let earned = 0, possible = 0;
  for (const item of usable) { const value = score(item); if (value == null || item.pointsPossible == null) continue; earned += value; possible += item.pointsPossible; }
  return possible > 0 ? earned / possible * 100 : course.summary.currentPercent;
}
function percent(value: number | null | undefined) { return value == null ? "—" : `${value.toFixed(1)}%`; }
function date(value: string, zone: string) { return formatInstant(value, zone, { month: "short", day: "numeric", year: "numeric" }); }
function relative(value: string, zone: string) { const delta = Math.max(0, Date.now() - new Date(value).getTime()); if (delta < 60_000) return "just now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return date(value, zone); }
function formatPoints(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function title(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
