import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveSession, normalizeOrigin, sameOrigin, toChromeCookie } from "../extension/src/cookies.js";

const ORIGIN = "https://ufl.instructure.com";
const NOW = 1_800_000_000;

test("origins must be https (or localhost) and are reduced to the origin", () => {
  assert.equal(normalizeOrigin(" https://ufl.instructure.com/courses/1 "), ORIGIN);
  assert.equal(normalizeOrigin("http://ufl.instructure.com"), null);
  assert.equal(normalizeOrigin("http://localhost:3000/x"), "http://localhost:3000");
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
  assert.equal(sameOrigin("https://ufl.instructure.com/courses/1", ORIGIN), true);
  assert.equal(sameOrigin("https://ufl.instructure.com.evil.test/", ORIGIN), false);
  assert.equal(sameOrigin("nonsense", ORIGIN), false);
});

test("cookies are installed host-only on the Canvas host, preserving flags", () => {
  const out = toChromeCookie({ name: "canvas_session", value: "v", domain: ".instructure.com", path: "/", expires: NOW + 100, httpOnly: true, secure: true, sameSite: "None" }, ORIGIN, NOW);
  assert.equal(out.url, `${ORIGIN}/`);
  assert.equal("domain" in out, false, "must stay host-only so other Canvas tenants never receive it");
  assert.deepEqual([out.httpOnly, out.secure, out.sameSite, out.expirationDate], [true, true, "no_restriction", NOW + 100]);
  const session = toChromeCookie({ name: "_csrf_token", value: "v", domain: "ufl.instructure.com", path: "/", expires: -1, sameSite: "Lax" }, ORIGIN, NOW);
  assert.equal("expirationDate" in session, false);
});

test("cookies for other hosts, expired cookies and malformed entries are refused", () => {
  assert.equal(toChromeCookie({ name: "a", value: "b", domain: "idp.ufl.edu", path: "/" }, ORIGIN, NOW), null);
  assert.equal(toChromeCookie({ name: "a", value: "b", domain: "evil.com", path: "/" }, ORIGIN, NOW), null);
  assert.equal(toChromeCookie({ name: "a", value: "b", domain: "", path: "/" }, ORIGIN, NOW), null);
  assert.equal(toChromeCookie({ name: "a", value: "b", domain: ORIGIN.slice(8), path: "/", expires: NOW - 1 }, ORIGIN, NOW), null);
  assert.equal(toChromeCookie({ value: "b", domain: ORIGIN.slice(8) }, ORIGIN, NOW), null);
  assert.equal(toChromeCookie(null, ORIGIN, NOW), null);
});

test("a live Canvas session is recognised only by a non-expired session cookie", () => {
  assert.equal(hasLiveSession([{ name: "canvas_session", session: true }], NOW), true);
  assert.equal(hasLiveSession([{ name: "canvas_session", expirationDate: NOW + 5 }], NOW), true);
  assert.equal(hasLiveSession([{ name: "canvas_session", expirationDate: NOW - 5 }], NOW), false);
  assert.equal(hasLiveSession([{ name: "_csrf_token", session: true }], NOW), false);
  assert.equal(hasLiveSession([], NOW), false);
});
