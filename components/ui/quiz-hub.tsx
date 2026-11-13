"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatInstant } from "@/lib/time";
import { courseColor } from "@/lib/views/build";
import { AppLink } from "./app-link";
import type { QuizSummary } from "./quiz-types";
import { useDisplayTimeZone } from "./use-display-timezone";
import styles from "./quiz-hub.module.css";

type Filter = "actionable" | "in_progress" | "history" | "unsupported";
type Freshness = { lastSuccessAt: string | null; freshUntil: string | null; stale: boolean; refreshing: boolean; lastErrorCode: string | null };
type Response = { quizzes: QuizSummary[]; freshness: Freshness; refresh: { enqueued: boolean; jobId: string | null }; error?: string };
const filters: { id: Filter; label: string }[] = [{ id: "actionable", label: "Actionable" }, { id: "in_progress", label: "In progress" }, { id: "history", label: "History" }, { id: "unsupported", label: "Canvas only" }];
const pageSize = 10;

export function QuizHub() {
  const timeZone = useDisplayTimeZone();
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("actionable");
  const [page, setPage] = useState(0);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const response = await fetch(`/api/canvas/quizzes${force ? "?refresh=1" : ""}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      const value = await response.json() as Response;
      if (!response.ok) throw new Error(value.error || "Quizzes are unavailable");
      setQuizzes(value.quizzes ?? []); setFreshness(value.freshness); setError("");
      return value.freshness;
    } catch {
      setError(!navigator.onLine ? "You are offline. Previously loaded quiz data remains on this page." : "Quiz freshness could not be checked. Saved quiz data is unchanged; retry when Canvas Grove is reachable.");
      return null;
    } finally { setLoading(false); if (force) setRefreshing(false); }
  }, []);

  useEffect(() => { const start = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(start); }, [load]);
  useEffect(() => { if (!freshness?.refreshing) return; const baseline = freshness.lastSuccessAt, timer = window.setInterval(() => { void load().then(next => { if (next && !next.refreshing && next.lastSuccessAt !== baseline) window.clearInterval(timer); }); }, 3_000); return () => window.clearInterval(timer); }, [freshness?.lastSuccessAt, freshness?.refreshing, load]);
  const filtered = useMemo(() => filterQuizzes(quizzes, filter), [filter, quizzes]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const busy = refreshing || Boolean(freshness?.refreshing);
  function selectFilter(value: Filter) { setFilter(value); setPage(0); }

  return <section className={styles.hub} aria-labelledby="quiz-hub-title">
    <div className={styles.hubHead}>
      <h2 id="quiz-hub-title" className="sr-only">Quiz worklist</h2>
      <div className={styles.freshness}><span className={freshness?.lastErrorCode || freshness?.stale ? styles.stale : styles.fresh} role="status" aria-live="polite"><i aria-hidden="true" />{busy ? "Refreshing in background" : freshness?.stale ? "Update due" : freshness?.lastSuccessAt ? `Updated ${relative(freshness.lastSuccessAt, timeZone)}` : "Not synced yet"}</span><button disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "Requesting…" : "Refresh"}</button></div>
    </div>

    <div className={styles.tabs} role="tablist" aria-label="Filter quizzes" onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; const next = (filters.findIndex(item => item.id === filter) + (event.key === "ArrowRight" ? 1 : -1) + filters.length) % filters.length; selectFilter(filters[next].id); requestAnimationFrame(() => document.getElementById(`quiz-tab-${filters[next].id}`)?.focus()); }}>{filters.map(item => <button key={item.id} id={`quiz-tab-${item.id}`} role="tab" aria-selected={filter === item.id} aria-controls="quiz-worklist" tabIndex={filter === item.id ? 0 : -1} onClick={() => selectFilter(item.id)}>{item.label}<span>{filterQuizzes(quizzes, item.id).length}</span></button>)}</div>
    {error && <div className={styles.inlineError} role="alert"><span>{error}</span><button onClick={() => void load(true)}>Try again</button></div>}

    <div id="quiz-worklist" role="tabpanel" aria-labelledby={`quiz-tab-${filter}`} className={styles.tableFrame}>
      {loading && quizzes.length === 0 ? <QuizSkeleton /> : filtered.length === 0 ? <Empty filter={filter} /> : <div className={styles.table} role="table" aria-label={`${filters.find(item => item.id === filter)?.label} quizzes`}>
        <div className={styles.tableHead} role="row"><span role="columnheader">Assessment</span><span role="columnheader">Course</span><span role="columnheader">Due</span><span role="columnheader">Status</span><span role="columnheader">Attempts</span><span role="columnheader"><span className="sr-only">Action</span></span></div>
        <div className={styles.rows} role="rowgroup">{visible.map(quiz => <QuizRow key={quiz.id} quiz={quiz} timeZone={timeZone} />)}</div>
      </div>}
      {filtered.length > pageSize && <nav className={styles.pagination} aria-label="Quiz worklist pages"><button disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button><span>Page {page + 1} of {pages}</span><button disabled={page >= pages - 1} onClick={() => setPage(value => Math.min(pages - 1, value + 1))}>Next</button></nav>}
    </div>
  </section>;
}

function QuizRow({ quiz, timeZone }: { quiz: QuizSummary; timeZone: string }) {
  const blocked = quiz.status === "unsupported" || quiz.status === "locked";
  const historical = ["completed", "past_due", "attempts_exhausted"].includes(quiz.status);
  const action = quiz.status === "in_progress" ? "Resume" : quiz.retakeAllowed ? "Review & retake" : historical ? "View details" : "Prepare";
  return <article className={`${styles.row} c${courseColor(quiz.courseId)}`} role="row">
    <div className={styles.title} role="cell"><span className={styles.mobileLabel}>Assessment</span><strong>{quiz.title}</strong><small>{quiz.questionCount == null ? "Question count unavailable" : `${quiz.questionCount} questions`}{quiz.timeLimitMinutes ? ` · ${quiz.timeLimitMinutes} min` : ""}</small></div>
    <div className={styles.course} role="cell"><span className={styles.mobileLabel}>Course</span><strong>{quiz.courseCode || quiz.courseName}</strong><small>{quiz.courseName}</small></div>
    <div role="cell"><span className={styles.mobileLabel}>Due</span><time dateTime={quiz.dueAt ?? undefined}>{quiz.dueAt ? shortDate(quiz.dueAt, timeZone) : "No due date"}</time></div>
    <div role="cell"><span className={styles.mobileLabel}>Status</span><Status status={quiz.status} stale={Boolean(quiz.statusStale)} /></div>
    <div role="cell"><span className={styles.mobileLabel}>Attempts</span><span>{attemptLabel(quiz)}</span></div>
    <div className={styles.action} role="cell">{blocked ? <span title={quiz.supportReason || undefined}>Use Canvas</span> : <AppLink href={`/quizzes/${quiz.id}`}>{action}<b aria-hidden="true">→</b></AppLink>}</div>
  </article>;
}

function QuizSkeleton() { return <div className={styles.skeleton} role="status"><span className="sr-only">Loading saved quizzes</span><i /><i /><i /><i /></div>; }
function Status({ status, stale }: { status: QuizSummary["status"]; stale: boolean }) { return <span className={`${styles.badge} ${styles[status]}`}>{status.replaceAll("_", " ")}{stale && <small title="Status may be stale">•</small>}</span>; }
function Empty({ filter }: { filter: Filter }) { const copy: Record<Filter, [string, string]> = { actionable: ["You’re caught up", "No available, upcoming, or in-progress quizzes need attention."], in_progress: ["No active attempts", "Started quizzes will stay here until Canvas records a submission."], history: ["No quiz history yet", "Completed, closed, and exhausted attempts will appear here."], unsupported: ["No Canvas-only quizzes", "Locked, proctored, and unsupported quizzes will appear here."] }; return <div className={styles.empty}><span aria-hidden="true">✓</span><h3>{copy[filter][0]}</h3><p>{copy[filter][1]}</p></div>; }

function filterQuizzes(quizzes: QuizSummary[], filter: Filter) {
  const selected = quizzes.filter(quiz => filter === "actionable" ? (quiz.actionable ?? ["in_progress", "available", "not_yet_available", "upcoming"].includes(quiz.status)) && !["completed", "past_due", "attempts_exhausted"].includes(quiz.status) : filter === "in_progress" ? quiz.status === "in_progress" : filter === "history" ? ["completed", "past_due", "attempts_exhausted"].includes(quiz.status) : ["unsupported", "locked"].includes(quiz.status));
  return [...selected].sort((a, b) => filter === "actionable" || filter === "in_progress" ? (a.status === "in_progress" && b.status !== "in_progress" ? -1 : b.status === "in_progress" && a.status !== "in_progress" ? 1 : ascendingDate(a.dueAt) - ascendingDate(b.dueAt)) : descendingDate(b.completedAt || b.dueAt) - descendingDate(a.completedAt || a.dueAt));
}
function attemptLabel(quiz: QuizSummary) { if (quiz.status === "in_progress") return "Active"; if (quiz.attemptsUnlimited) return quiz.attemptsUsed ? `${quiz.attemptsUsed} submitted · retakes on` : "Unlimited"; if (quiz.attemptsKnown === false || quiz.attemptsRemaining == null) return quiz.attemptsUsed ? `${quiz.attemptsUsed} submitted · see Canvas` : "Set by Canvas"; if (quiz.attemptsUsed > 0 && quiz.attemptsRemaining > 0) return `${quiz.attemptsUsed} used · ${quiz.attemptsRemaining} left`; return quiz.attemptsRemaining === 0 ? "None left" : `${quiz.attemptsRemaining} remaining`; }
function shortDate(value: string, zone: string) { return formatInstant(value, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function relative(value: string, zone: string) { const delta = Math.max(0, Date.now() - new Date(value).getTime()); if (delta < 60_000) return "just now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return shortDate(value, zone); }
function ascendingDate(value?: string | null) { return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER; }
function descendingDate(value?: string | null) { return value ? new Date(value).getTime() : Number.MIN_SAFE_INTEGER; }
