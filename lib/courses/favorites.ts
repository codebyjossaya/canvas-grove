import type { CanvasRequest } from "@/lib/bridge/types";

export function favoriteRequest(canvasCourseId: string, active: boolean): CanvasRequest {
  if (!canvasCourseId || canvasCourseId.includes("/") || canvasCourseId.includes("\\")) throw new Error("Invalid Canvas course id");
  const externalId = /^\d+$/.test(canvasCourseId) ? canvasCourseId : `sis_course_id:${encodeURIComponent(canvasCourseId)}`;
  return { method: active ? "POST" : "DELETE", path: `/api/v1/users/self/favorites/courses/${externalId}` };
}

export type FavoriteOptimisticState = { previous: boolean; active: boolean };
export function beginFavoriteChange(previous: boolean, active: boolean): FavoriteOptimisticState { return { previous, active }; }
export function finishFavoriteChange(state: FavoriteOptimisticState, result: { ok: boolean; active?: boolean }) { return result.ok && typeof result.active === "boolean" ? result.active : state.previous; }

export function favoriteFailure(status: number, authRequired = false) {
  if (authRequired || status === 401) return { status: 401, code: "CANVAS_AUTH_EXPIRED", error: "Canvas sign-in has expired. Reconnect Canvas, then try again." };
  if (status === 429) return { status: 429, code: "RATE_LIMITED", error: "Canvas is rate limiting changes. Wait a moment, then retry." };
  if (status === 403) return { status: 403, code: "CANVAS_RESTRICTED", error: "Canvas does not allow this course to be changed." };
  return { status: status >= 400 && status < 500 ? status : 502, code: "CANVAS_REQUEST_FAILED", error: "Canvas could not update this course right now." };
}

export function reconcileFavoriteFlags(courseIds: string[], favoriteIds: string[]) {
  const favorites = new Set(favoriteIds);
  return courseIds.map((id) => ({ id, active: favorites.has(id) }));
}
