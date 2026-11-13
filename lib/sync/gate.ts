import { createHash } from "node:crypto";
import { isQuizHot } from "./catalog";

// Change-detection gate for the per-course sweeps (quizzes, course_content).
// A sweep costs ~1 request per course per list plus 1 per quiz/page, and most courses
// never change between sweeps. The ledger remembers, per owner and course, when it was last
// swept, a fingerprint of what came back, and whether it needs fast attention. A course is
// re-swept only when its tier's minimum age has elapsed. First sight (empty ledger, e.g. after a
// worker restart) always sweeps, so nothing is skipped on faith.

export type CourseTier = "hot" | "watch" | "active" | "quiet" | "concluded";
type Rec = Record<string, unknown>;

const MIN = 60_000, HOUR = 60 * MIN;
/** Minimum age before a course is swept again, per kind and tier. Hot: every cycle (bounded by the 60s/5min hot cadence). */
export const SWEEP_MIN_AGE_MS: Record<"quizzes" | "course_content", Record<CourseTier, number>> = {
  quizzes: { hot: 0, watch: 10 * MIN, active: HOUR, quiet: 2 * HOUR, concluded: 12 * HOUR },
  course_content: { hot: 0, watch: 2 * HOUR, active: 2 * HOUR, quiet: 4 * HOUR, concluded: 12 * HOUR },
};
/** Consecutive identical fingerprints before an active course is treated as quiet. */
export const QUIET_AFTER_UNCHANGED = 2;
export const WATCH_HORIZON_MS = 7 * 24 * HOUR;
export const SHORT_WINDOW_MS = 30 * MIN;
export const OPEN_ATTEMPT_MAX_AGE_MS = 3 * HOUR;
/** A course swept less than this long ago is in a fast (hot) cycle: per-quiz submissions are fetched only for hot quizzes. */
export const FAST_CYCLE_MS = 10 * MIN;

const time = (value: unknown): number | null => { if (typeof value !== "string" && !(value instanceof Date)) return null; const t = new Date(value).getTime(); return Number.isFinite(t) ? t : null; };

/** Concluded: Canvas says completed, or the course/term end date has passed. */
export function courseConcluded(course: Rec, now: number): boolean {
  if (course.concluded === true || course.workflow_state === "completed") return true;
  const term = course.term && typeof course.term === "object" ? course.term as Rec : {};
  for (const end of [time(course.end_at), time(term.end_at)]) if (end !== null && end < now) return true;
  return false;
}

/** An unfinished attempt that is plausibly still being taken (Canvas keeps in-progress attempts as `untaken`). */
export function attemptOpen(submission: Rec | null | undefined, now: number): boolean {
  if (!submission || submission.workflow_state !== "untaken" || submission.finished_at) return false;
  const started = time(submission.started_at);
  if (started === null) return false;
  const end = time(submission.end_at);
  return end !== null ? end >= now : now - started <= OPEN_ATTEMPT_MAX_AGE_MS;
}

/** hot = needs the fast cadence now; watch = something dated in the next week or a short-window (attendance-style) quiz. */
export function quizTier(quiz: Rec, submission: Rec | null | undefined, now: number): "hot" | "watch" | null {
  const due = time(quiz.due_at), unlock = time(quiz.unlock_at), lock = time(quiz.lock_at);
  if (attemptOpen(submission, now) || isQuizHot({ dueAt: due, unlockAt: unlock, lockAt: lock }, now)) return "hot";
  if (unlock !== null && lock !== null && lock - unlock <= SHORT_WINDOW_MS) return "watch";
  for (const t of [due, unlock, lock]) if (t !== null && t >= now && t <= now + WATCH_HORIZON_MS) return "watch";
  return null;
}

/** Stable digest of the fields whose change matters, order independent. */
export function fingerprint(rows: Array<Rec | null | undefined>, fields: string[]): string {
  const lines = rows.filter((row): row is Rec => Boolean(row)).map((row) => JSON.stringify(fields.map((field) => row[field] ?? null))).sort();
  return createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16);
}

type Entry = { sweptAt: number; fingerprint: string; unchanged: number; tier: CourseTier };

export class SweepLedger {
  private entries = new Map<string, Entry>();
  constructor(private readonly max = 5000) {}
  private key(scope: string, kind: string, courseId: string) { return `${scope}|${kind}|${courseId}`; }
  /** True when the course should be swept now. `concluded` always wins over remembered tiers. */
  due(scope: string, kind: "quizzes" | "course_content", courseId: string, now: number, concluded: boolean): boolean {
    const entry = this.entries.get(this.key(scope, kind, courseId));
    if (!entry) return true;
    const tier: CourseTier = concluded ? "concluded" : entry.tier;
    return now - entry.sweptAt >= SWEEP_MIN_AGE_MS[kind][tier];
  }
  /** Record a completed sweep. `tier` is hot/watch/null from quizTier (null for content); unchanged fingerprints demote to quiet. */
  record(scope: string, kind: "quizzes" | "course_content", courseId: string, now: number, print: string, base: "hot" | "watch" | null) {
    const key = this.key(scope, kind, courseId);
    const previous = this.entries.get(key);
    const unchanged = previous && previous.fingerprint === print ? previous.unchanged + 1 : 0;
    const tier: CourseTier = base ?? (unchanged >= QUIET_AFTER_UNCHANGED ? "quiet" : "active");
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(key, { sweptAt: now, fingerprint: print, unchanged, tier });
  }
  /** Milliseconds since the course was last swept, undefined when never. */
  ageOf(scope: string, kind: string, courseId: string, now: number): number | undefined { const entry = this.entries.get(this.key(scope, kind, courseId)); return entry ? now - entry.sweptAt : undefined; }
  private open = new Map<string, Set<string>>();
  /** Quiz ids with an open attempt as of the last sweep: they keep being re-checked in fast (hot-only) cycles. */
  setOpenQuizzes(scope: string, courseId: string, ids: Set<string>) { this.open.set(`${scope}|${courseId}`, ids); }
  openQuizzes(scope: string, courseId: string): Set<string> { return this.open.get(`${scope}|${courseId}`) ?? new Set(); }
  tierOf(scope: string, kind: string, courseId: string): CourseTier | undefined { return this.entries.get(this.key(scope, kind, courseId))?.tier; }
  clear() { this.entries.clear(); this.open.clear(); }
}

export const sweepLedger = new SweepLedger();
