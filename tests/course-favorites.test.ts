import assert from "node:assert/strict";
import test from "node:test";
import { beginFavoriteChange, favoriteFailure, favoriteRequest, finishFavoriteChange, reconcileFavoriteFlags } from "../lib/courses/favorites";

test("favorite API maps activation to POST and deactivation to DELETE", () => {
  assert.deepEqual(favoriteRequest("1170", true), { method: "POST", path: "/api/v1/users/self/favorites/courses/1170" });
  assert.deepEqual(favoriteRequest("1170", false), { method: "DELETE", path: "/api/v1/users/self/favorites/courses/1170" });
  assert.deepEqual(favoriteRequest("SIS 1", true), { method: "POST", path: "/api/v1/users/self/favorites/courses/sis_course_id:SIS%201" });
  assert.throws(() => favoriteRequest("bad/id", true));
});

test("repeated intent is deterministic and optimistic failure rolls back", () => {
  assert.deepEqual(favoriteRequest("1170", true), favoriteRequest("1170", true));
  const state = beginFavoriteChange(false, true);
  assert.equal(state.active, true);
  assert.equal(finishFavoriteChange(state, { ok: false }), false);
  assert.equal(finishFavoriteChange(state, { ok: true, active: true }), true);
});

test("auth expiry, restrictions, and rate limits remain distinct", () => {
  assert.equal(favoriteFailure(401).code, "CANVAS_AUTH_EXPIRED");
  assert.equal(favoriteFailure(200, true).code, "CANVAS_AUTH_EXPIRED");
  assert.equal(favoriteFailure(403).code, "CANVAS_RESTRICTED");
  assert.equal(favoriteFailure(429).code, "RATE_LIMITED");
  assert.equal(favoriteFailure(500).status, 502);
});

test("favorite reconciliation exactly mirrors the Canvas favorites list", () => {
  assert.deepEqual(reconcileFavoriteFlags(["1", "2", "3"], ["2"]), [{ id: "1", active: false }, { id: "2", active: true }, { id: "3", active: false }]);
});
