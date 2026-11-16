import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasLiveSession, normalizeOrigin, sameOrigin, toChromeCookie, toServerCookie } from "../extension/src/cookies.js";
import { isAuthPath, signInSignal } from "../extension/src/detect.js";

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

test("browser cookies exported to Grove are narrowed to the exact Canvas host", () => {
  const out = toServerCookie({
    name: "canvas_session", value: "secret", domain: ".instructure.com", path: "/", expirationDate: NOW + 60,
    httpOnly: true, secure: true, sameSite: "no_restriction", storeId: "profile-1",
  }, ORIGIN, NOW);
  assert.deepEqual(out, {
    name: "canvas_session", value: "secret", domain: "ufl.instructure.com", path: "/", expires: NOW + 60,
    httpOnly: true, secure: true, sameSite: "None",
  });
  assert.equal("storeId" in out, false);
});

test("browser cookie export refuses foreign, expired, oversized and wrong-partition cookies", () => {
  const base = { name: "canvas_session", value: "v", domain: ".instructure.com", path: "/", session: true };
  assert.equal(toServerCookie({ ...base, domain: "login.ufl.edu" }, ORIGIN, NOW), null);
  assert.equal(toServerCookie({ ...base, expirationDate: NOW - 1 }, ORIGIN, NOW), null);
  assert.equal(toServerCookie({ ...base, value: "x".repeat(16_385) }, ORIGIN, NOW), null);
  assert.equal(toServerCookie({ ...base, partitionKey: { topLevelSite: "https://evil.example" } }, ORIGIN, NOW), null);
});

test("Canvas host access is optional and requested per exact origin", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/src/manifest.template.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["__GROVE_PATTERN__"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.ok(!JSON.stringify(manifest.host_permissions).includes("instructure.com"));
});

test("manifest 0.4.0 asks only for what the tab + side panel sign-in needs", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/src/manifest.template.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.4.0");
  assert.deepEqual(manifest.permissions, ["cookies", "storage", "sidePanel", "webRequest", "scripting"]);
  assert.ok(!manifest.permissions.includes("tabs"), "tab placement and URL watching work without the tabs permission");
  assert.equal("side_panel" in manifest, false, "the panel is enabled per sign-in tab, never by default");
  assert.deepEqual(manifest.content_scripts, [{ matches: ["__GROVE_PATTERN__"], js: ["content.js"], run_at: "document_start" }]);
});

test("the old popup-window sign-in is gone", () => {
  const background = readFileSync(new URL("../extension/src/background.js", import.meta.url), "utf8");
  assert.ok(!background.includes("windows.create"));
  assert.ok(!background.includes("canvas-auth-open"));
});

test("sign-in signals: Canvas pages outside login, Canvas API calls and session Set-Cookie headers", () => {
  const page = (path, extra = {}) => ({ url: `${ORIGIN}${path}`, type: "main_frame", statusCode: 200, ...extra });
  assert.equal(signInSignal(page("/"), ORIGIN), "page");
  assert.equal(signInSignal(page("/courses/1"), ORIGIN), "page");
  for (const path of ["/login", "/login/ldap", "/login/saml/1", "/saml/acs", "/logout"]) assert.equal(signInSignal(page(path), ORIGIN), null, path);
  assert.equal(signInSignal(page("/", { statusCode: 302 }), ORIGIN), null);
  assert.equal(signInSignal({ url: `${ORIGIN}/api/v1/users/self`, type: "xmlhttprequest", statusCode: 200 }, ORIGIN), "api");
  assert.equal(signInSignal({ url: `${ORIGIN}/api/v1/users/self`, type: "xmlhttprequest", statusCode: 401 }, ORIGIN), null);
  assert.equal(signInSignal(page("/", { url: "https://idp.ufl.edu/" }), ORIGIN), null, "other hosts never count");
  assert.equal(signInSignal(page("/", { url: `${ORIGIN}.evil.test/` }), ORIGIN), null);
  const headers = (value) => page("/login", { statusCode: 302, responseHeaders: [{ name: "set-cookie", value }] });
  assert.equal(signInSignal(headers("_normandy_session=x; path=/"), ORIGIN), "set-cookie");
  assert.equal(signInSignal(headers("_csrf_token=x\nlog_session_id=y"), ORIGIN), "set-cookie");
  assert.equal(signInSignal(headers("_csrf_token=x"), ORIGIN), null);
  assert.equal(signInSignal({ url: "not a url" }, ORIGIN), null);
  assert.equal(isAuthPath("/login/canvas"), true);
  assert.equal(isAuthPath("/courses"), false);
});
