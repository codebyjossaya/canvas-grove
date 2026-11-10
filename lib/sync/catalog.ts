import type { CanvasRequest } from "@/lib/bridge/types";

export type SyncKind = "planner" | "inbox" | "announcements" | "assignments" | "courses" | "grades" | "favorites" | "quizzes" | "course_content";

export const syncPolicies: Record<SyncKind, { intervalMs: number; staleAfterMs: number; priority: number }> = {
  planner: { intervalMs: 5 * 60_000, staleAfterMs: 10 * 60_000, priority: 100 },
  inbox: { intervalMs: 5 * 60_000, staleAfterMs: 10 * 60_000, priority: 90 },
  announcements: { intervalMs: 10 * 60_000, staleAfterMs: 20 * 60_000, priority: 80 },
  assignments: { intervalMs: 15 * 60_000, staleAfterMs: 30 * 60_000, priority: 70 },
  grades: { intervalMs: 30 * 60_000, staleAfterMs: 60 * 60_000, priority: 60 },
  courses: { intervalMs: 6 * 60 * 60_000, staleAfterMs: 12 * 60 * 60_000, priority: 40 },
  favorites: { intervalMs: 15 * 60_000, staleAfterMs: 30 * 60_000, priority: 65 },
  // Quiz inventory is read from PostgreSQL on page load. The worker refreshes
  // it out of band and temporarily tightens this cadence near deadlines.
  quizzes: { intervalMs: 5 * 60_000, staleAfterMs: 10 * 60_000, priority: 85 },
  course_content: { intervalMs: 30 * 60_000, staleAfterMs: 60 * 60_000, priority: 75 },
};

export function deterministicJitterMs(accountId: string, kind: SyncKind): number {
  let hash = 2166136261;
  for (const char of `${accountId}:${kind}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const ratio = ((hash >>> 0) / 0xffffffff) * 0.3 - 0.15;
  return Math.round(syncPolicies[kind].intervalMs * ratio);
}

export function backoffMs(attempt: number): number {
  return [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000][Math.min(Math.max(attempt - 1, 0), 3)];
}

export function primaryRequest(kind: SyncKind): CanvasRequest {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const end = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  switch (kind) {
    case "planner": return { method: "GET", path: `/api/v1/planner/items?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100` };
    case "inbox": return { method: "GET", path: "/api/v1/conversations?scope=inbox&filter[]=unread&per_page=100" };
    case "courses": return { method: "GET", path: "/api/v1/courses?enrollment_state=active&include[]=term&include[]=favorites&per_page=100" };
    case "favorites": return { method: "GET", path: "/api/v1/users/self/favorites/courses?per_page=100" };
    case "grades": return { method: "GET", path: "/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=current_grading_period_scores&per_page=100" };
    case "assignments": return { method: "GET", path: "/api/v1/users/self/upcoming_events?per_page=100" };
    case "announcements": return { method: "GET", path: "/api/v1/users/self/activity_stream?only_active_courses=true&per_page=100" };
    // Quiz sync is a bounded multi-request crawl implemented by the executor.
    case "quizzes": return { method: "GET", path: "/api/v1/courses?enrollment_state=active&per_page=100" };
    case "course_content": return { method: "GET", path: "/api/v1/courses?enrollment_state=active&per_page=100" };
  }
}
