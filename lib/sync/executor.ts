import { primaryRequest, type SyncKind } from "./catalog";
import { CANVAS_PAGE_SIZE, type CanvasApi } from "../canvas/session-client";
import { attemptOpen, courseConcluded, FAST_CYCLE_MS, fingerprint, quizTier, sweepLedger } from "./gate";

// Sync talks to Canvas only through the server-side cookie-authenticated API
// client (lib/canvas/session-client.ts). The hosted browser is login-only and
// is never used for sync requests.

export type SyncExecution = {
  kind: SyncKind;
  ok: boolean;
  authExpired: boolean;
  rateLimited: boolean;
  retryAfterMs?: number;
  status: number;
  records: unknown;
};

type CanvasRecord = Record<string, unknown>;
type CanvasResult = { ok: boolean; status: number; authRequired: boolean; data?: unknown; rateLimitRemaining?: number; retryAfterSeconds?: number; nextPath?: string; hasLinkHeader?: boolean };
type QuizCourseSync = { course: CanvasRecord; quizzes: Array<{ quiz: CanvasRecord; submission: CanvasRecord | null }>; assignments: CanvasRecord[]; complete: boolean };
type ContentCourseSync = { course: CanvasRecord; tabs: CanvasRecord[]; folders: CanvasRecord[]; files: CanvasRecord[]; modules: CanvasRecord[]; pages: CanvasRecord[]; groups: CanvasRecord[]; complete: boolean };

/** Hard cap on pages per collection; with CANVAS_PAGE_SIZE this bounds rows (and memory) per list. */
export const MAX_PAGES = 10;

function record(value: unknown): value is CanvasRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; output[index] = await work(items[index]); }
  }));
  return output;
}

export function firstPagePath(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}per_page=${CANVAS_PAGE_SIZE}`;
}

/** Follows Canvas `Link: rel="next"`; without a Link header falls back to numbered pages. Bounded by MAX_PAGES. */
export async function pageAll(api: CanvasApi, path: string) {
  const output: CanvasRecord[] = [];
  let next: string | undefined = firstPagePath(path);
  for (let page = 1; page <= MAX_PAGES && next; page += 1) {
    const result: CanvasResult = await api.request({ method: "GET", path: next });
    if (!result.ok) return { output, result, complete: false };
    if (!Array.isArray(result.data)) return { output, result: { ...result, ok: false, status: 502 } as CanvasResult, complete: false };
    const rows = result.data.filter(record); output.push(...rows);
    next = result.hasLinkHeader ? result.nextPath : rows.length >= CANVAS_PAGE_SIZE ? `${firstPagePath(path)}&page=${page + 1}` : undefined;
    if (!next) return { output, result, complete: true };
  }
  return { output, result: { ok: false, status: 502, authRequired: false } as CanvasResult, complete: false };
}
async function executeQuizSync(api: CanvasApi, scope: string, now: number): Promise<SyncExecution> {
  const courses = await pageAll(api, "/api/v1/courses?enrollment_state=active&include[]=term&include[]=favorites");
  if (!courses.result.ok) return resultFrom("quizzes", courses.result);
  let fatal: CanvasResult | null = null;
  // Change gate: only courses whose tier says they are due are swept; the rest are simply absent
  // from the payload (persistence leaves absent courses untouched).
  const targets = courses.complete ? courses.output.filter((course) => { const id = String(course.id ?? ""); return !/^\d+$/.test(id) || sweepLedger.due(scope, "quizzes", id, now, courseConcluded(course, now)); }) : courses.output;
  const payload = await mapLimited(targets, 3, async (course): Promise<QuizCourseSync> => {
    const id = String(course.id ?? "");
    if (!/^\d+$/.test(id)) return { course, quizzes: [], assignments: [], complete: false };
    const [quizPage, assignmentPage] = await Promise.all([
      pageAll(api, `/api/v1/courses/${id}/quizzes`),
      pageAll(api, `/api/v1/courses/${id}/assignments?include[]=submission`),
    ]);
    for (const failed of [quizPage.result, assignmentPage.result]) {
      if (!failed.ok && (failed.authRequired || failed.status === 401 || failed.status === 429)) fatal ??= failed;
    }
    if (!quizPage.result.ok) return { course, quizzes: [], assignments: assignmentPage.output, complete: false };
    // Fast cycle (course swept moments ago, i.e. the hot cadence): only quizzes that are hot by date
    // or had an open attempt last time need their submission re-read; the rest keep their stored state.
    const age = sweepLedger.ageOf(scope, "quizzes", id, now), fast = age !== undefined && age < FAST_CYCLE_MS, openBefore = sweepLedger.openQuizzes(scope, id);
    const quizzes = await mapLimited(quizPage.output, 5, async (quiz) => {
      const quizId = String(quiz.id ?? "");
      if (!/^\d+$/.test(quizId)) return { quiz, submission: null };
      if (fast && !openBefore.has(quizId) && quizTier(quiz, null, now) === null) return { quiz, submission: null };
      const result = await api.request({ method: "GET", path: `/api/v1/courses/${id}/quizzes/${quizId}/submission?include[]=quiz` });
      if (!result.ok) {
        if (result.authRequired || result.status === 401 || result.status === 429) fatal ??= result;
        return { quiz, submission: null };
      }
      const wrapper = record(result.data) ? result.data : {};
      const submissions = Array.isArray(wrapper.quiz_submissions) ? wrapper.quiz_submissions.filter(record) : [];
      submissions.sort((left, right) => Number(right.attempt ?? 0) - Number(left.attempt ?? 0));
      return { quiz, submission: submissions[0] ?? null };
    });
    if (!fast || quizzes.some((entry) => entry.submission)) sweepLedger.setOpenQuizzes(scope, id, new Set(quizzes.filter((entry) => attemptOpen(entry.submission, now)).map((entry) => String(entry.quiz.id))));
    const tiers = quizzes.map((entry) => quizTier(entry.quiz, entry.submission, now));
    const base = tiers.includes("hot") ? "hot" : tiers.includes("watch") ? "watch" : null;
    const print = fingerprint(quizzes.flatMap((entry) => [entry.quiz, entry.submission && { ...entry.submission, id: undefined }]), ["id", "title", "due_at", "unlock_at", "lock_at", "locked_for_user", "published", "workflow_state", "attempt", "finished_at", "kept_score"])
      + fingerprint(assignmentPage.output, ["id", "due_at", "lock_at", "workflow_state", "updated_at"]);
    sweepLedger.record(scope, "quizzes", id, now, print, base);
    return { course, quizzes, assignments: assignmentPage.output, complete: quizPage.complete && assignmentPage.complete };
  });
  if (fatal) return resultFrom("quizzes", fatal);
  return { kind: "quizzes", ok: true, authExpired: false, rateLimited: false, status: 200, records: { version: 1, courses: payload, complete: courses.complete && payload.every((item) => item.complete) } };
}

async function executeCourseContentSync(api: CanvasApi, scope: string, now: number): Promise<SyncExecution> {
  const courses = await pageAll(api, "/api/v1/courses?enrollment_state=active&include[]=term&include[]=syllabus_body&include[]=total_scores");
  if (!courses.result.ok) return resultFrom("course_content", courses.result);
  let fatal: CanvasResult | null = null;
  const targets = courses.complete ? courses.output.filter((course) => { const id = String(course.id ?? ""); return !/^\d+$/.test(id) || sweepLedger.due(scope, "course_content", id, now, courseConcluded(course, now)); }) : courses.output;
  const payload = await mapLimited(targets, 2, async (course): Promise<ContentCourseSync> => {
    const id = String(course.id ?? "");
    if (!/^\d+$/.test(id)) return { course, tabs: [], folders: [], files: [], modules: [], pages: [], groups: [], complete: false };
    const prefix = "/api/v1/courses/" + id;
    const [tabs, folders, files, modules, pageList, groups] = await Promise.all([
      pageAll(api, prefix + "/tabs"), pageAll(api, prefix + "/folders"),
      pageAll(api, prefix + "/files"), pageAll(api, prefix + "/modules?include[]=items"),
      pageAll(api, prefix + "/pages"), pageAll(api, prefix + "/assignment_groups?include[]=assignments&include[]=submission"),
    ]);
    const requests = [tabs, folders, files, modules, pageList, groups];
    for (const failed of requests.map((item) => item.result)) if (!failed.ok && (failed.authRequired || failed.status === 401 || failed.status === 429)) fatal ??= failed;
    const pages = await mapLimited(pageList.output, 4, async (page) => {
      const slug = typeof page.url === "string" ? page.url : "";
      if (!slug) return page;
      const detail = await api.request({ method: "GET", path: prefix + "/pages/" + encodeURIComponent(slug) });
      if (!detail.ok) { if (detail.authRequired || detail.status === 401 || detail.status === 429) fatal ??= detail; return page; }
      return record(detail.data) ? detail.data : page;
    });
    sweepLedger.record(scope, "course_content", id, now, [tabs, folders, files, modules, pageList, groups].map((item) => fingerprint(item.output, ["id", "updated_at", "modified_at", "locked", "hidden", "published", "workflow_state", "due_at", "url"])).join(""), null);
    return { course, tabs: tabs.output, folders: folders.output, files: files.output, modules: modules.output, pages, groups: groups.output, complete: requests.every((item) => item.result.ok && item.complete) };
  });
  if (fatal) return resultFrom("course_content", fatal);
  return { kind: "course_content", ok: true, authExpired: false, rateLimited: false, status: 200, records: { version: 1, courses: payload, complete: courses.complete && payload.every((item) => item.complete) } };
}

function resultFrom(kind: SyncKind, result: CanvasResult): SyncExecution {
  return { kind, ok: result.ok, authExpired: result.authRequired, rateLimited: result.status === 429 || result.rateLimitRemaining === 0,
    retryAfterMs: result.retryAfterSeconds === undefined ? undefined : Math.max(1, result.retryAfterSeconds) * 1000,
    status: result.status, records: result.data ?? null };
}

// ---------------------------------------------------------------- call hygiene
// Per-course endpoints that Canvas permanently refuses (403 "disabled for this course", 404
// "no such resource") used to be re-requested on every sync, a steady ~8% error rate. Remember
// them per owner for a while, and slow down when Canvas signals throttling.

/** How long a permanent 403/404 on a (owner, endpoint) is remembered before it is retried. */
export const DENIED_TTL_MS = 6 * 60 * 60_000;
/** Below this X-Rate-Limit-Remaining, pause before the next request. */
export const RATE_LIMIT_LOW_WATER = 100;
const MAX_DENIED = 5000;
const denied = new Map<string, { status: number; until: number }>();
const gates = new Map<string, number>();

/** Endpoint shape with ids and the query removed: safe to log and to aggregate on. */
export function endpointTemplate(path: string): string {
  return path.split("?")[0].replace(/\/\d+/g, "/:id").replace(/\/pages\/[^/]+/, "/pages/:slug");
}
/** Only the course-scoped list endpoints and quiz submissions are skippable; never self/courses roots or POSTs. */
function skippable(path: string): boolean { return /^\/api\/v1\/courses\/\d+\//.test(path); }
export function resetCallHygiene() { denied.clear(); gates.clear(); }

export type CallBreakdown = Record<string, number>;

/** Wraps a CanvasApi with a denied-endpoint cache, 429 / low-quota backoff and a value-free status tally. */
export function hygienic(api: CanvasApi, scope: string, options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): { api: CanvasApi; breakdown: CallBreakdown } {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const breakdown: CallBreakdown = {};
  const wrapped: CanvasApi = {
    ...api,
    async request(request) {
      const key = scope + "|" + endpointTemplate(request.path);
      const cacheKey = scope + "|" + request.path.split("?")[0];
      const cacheable = request.method === "GET" && skippable(request.path);
      const hit = cacheable ? denied.get(cacheKey) : undefined;
      if (hit && hit.until > now()) { breakdown["skipped " + endpointTemplate(request.path)] = (breakdown["skipped " + endpointTemplate(request.path)] ?? 0) + 1; return { ok: false, status: hit.status, authRequired: false } as Awaited<ReturnType<CanvasApi["request"]>>; }
      const gate = gates.get(scope) ?? 0;
      if (gate > now()) await sleep(gate - now());
      const result = await api.request(request);
      if (!result.ok) { const label = result.status + " " + endpointTemplate(request.path); breakdown[label] = (breakdown[label] ?? 0) + 1; }
      if (cacheable && (result.status === 403 || result.status === 404) && !result.authRequired) {
        if (denied.size >= MAX_DENIED) denied.delete(denied.keys().next().value as string);
        denied.set(cacheKey, { status: result.status, until: now() + DENIED_TTL_MS });
      } else if (denied.has(cacheKey) && result.ok) denied.delete(cacheKey);
      if (result.status === 429) gates.set(scope, now() + Math.min(60_000, Math.max(2_000, (result.retryAfterSeconds ?? 5) * 1000)));
      else if (typeof result.rateLimitRemaining === "number" && result.rateLimitRemaining < RATE_LIMIT_LOW_WATER) gates.set(scope, now() + 1_000);
      void key;
      return result;
    },
  };
  return { api: wrapped, breakdown };
}

/**
 * Upcoming assignment events plus the student's own submission state for every active course.
 * Submission state otherwise only arrives with the 2-4h course_content sweep, so a grade passback
 * or an external-tool (LTI) submission stayed "unsubmitted" in Grove for hours. One request per
 * active course (`students/submissions?student_ids[]=self`) keeps it within the 15-min cadence.
 */
async function executeAssignmentSync(api: CanvasApi, now: number): Promise<SyncExecution> {
  const events = await api.request(primaryRequest("assignments"));
  if (!events.ok) return resultFrom("assignments", events);
  const courses = await pageAll(api, "/api/v1/courses?enrollment_state=active&include[]=term");
  const submissions: Array<{ courseCanvasId: string; rows: CanvasRecord[]; complete: boolean }> = [];
  if (courses.result.ok) {
    const live = courses.output.filter((course) => /^\d+$/.test(String(course.id ?? "")) && !courseConcluded(course, now));
    let fatal: CanvasResult | null = null;
    const pages = await mapLimited(live, 3, async (course) => {
      const id = String(course.id);
      const page = await pageAll(api, `/api/v1/courses/${id}/students/submissions?student_ids[]=self`);
      if (!page.result.ok && (page.result.authRequired || page.result.status === 429)) fatal ??= page.result;
      return { courseCanvasId: id, rows: page.output, complete: page.complete };
    });
    if (fatal) return resultFrom("assignments", fatal);
    submissions.push(...pages);
  }
  return { ...resultFrom("assignments", events), records: { events: Array.isArray(events.data) ? events.data : [], submissions } };
}

/** Executes one leased sync job against Canvas through the server-side API client. */
export async function executeCanvasSyncJob(input: { kind: SyncKind; api: CanvasApi; scope?: string; onBreakdown?: (breakdown: CallBreakdown) => void }): Promise<SyncExecution> {
  const scope = input.scope ?? "default", now = Date.now();
  const { api, breakdown } = hygienic(input.api, scope);
  try {
    if (input.kind === "quizzes") return await executeQuizSync(api, scope, now);
    if (input.kind === "course_content") return await executeCourseContentSync(api, scope, now);
    if (input.kind === "assignments") return await executeAssignmentSync(api, now);
    const result = await api.request(primaryRequest(input.kind));
    return resultFrom(input.kind, result);
  } finally { if (Object.keys(breakdown).length) input.onBreakdown?.(breakdown); }
}
