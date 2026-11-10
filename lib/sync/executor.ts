import { primaryRequest, type SyncKind } from "./catalog";
import { CANVAS_PAGE_SIZE, type CanvasApi } from "../canvas/session-client";

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
async function executeQuizSync(api: CanvasApi): Promise<SyncExecution> {
  const courses = await pageAll(api, "/api/v1/courses?enrollment_state=active&include[]=term&include[]=favorites");
  if (!courses.result.ok) return resultFrom("quizzes", courses.result);
  let fatal: CanvasResult | null = null;
  const payload = await mapLimited(courses.output, 3, async (course): Promise<QuizCourseSync> => {
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
    const quizzes = await mapLimited(quizPage.output, 5, async (quiz) => {
      const quizId = String(quiz.id ?? "");
      if (!/^\d+$/.test(quizId)) return { quiz, submission: null };
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
    return { course, quizzes, assignments: assignmentPage.output, complete: quizPage.complete && assignmentPage.complete };
  });
  if (fatal) return resultFrom("quizzes", fatal);
  return { kind: "quizzes", ok: true, authExpired: false, rateLimited: false, status: 200, records: { version: 1, courses: payload, complete: courses.complete && payload.every((item) => item.complete) } };
}

async function executeCourseContentSync(api: CanvasApi): Promise<SyncExecution> {
  const courses = await pageAll(api, "/api/v1/courses?enrollment_state=active&include[]=term&include[]=syllabus_body&include[]=total_scores");
  if (!courses.result.ok) return resultFrom("course_content", courses.result);
  let fatal: CanvasResult | null = null;
  const payload = await mapLimited(courses.output, 2, async (course): Promise<ContentCourseSync> => {
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

/** Executes one leased sync job against Canvas through the server-side API client. */
export async function executeCanvasSyncJob(input: { kind: SyncKind; api: CanvasApi }): Promise<SyncExecution> {
  if (input.kind === "quizzes") return executeQuizSync(input.api);
  if (input.kind === "course_content") return executeCourseContentSync(input.api);
  const result = await input.api.request(primaryRequest(input.kind));
  return resultFrom(input.kind, result);
}
