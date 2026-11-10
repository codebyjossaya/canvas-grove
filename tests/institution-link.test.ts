import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CANVAS_LOGIN_PATH_PATTERN, isValidCanvasLoginPath, mergeDiscoveredAuthHosts, parseInstitutionLink, requireCanvasLoginPath, toCanvasLoginPath,
} from "../lib/canvas/institution";

test("UF SAML link keeps the exact auth-provider path", () => {
  assert.deepEqual(parseInstitutionLink("https://ufl.instructure.com/login/saml/355"), { canvasOrigin: "https://ufl.instructure.com", loginPath: "/login/saml/355" });
});

test("bare Canvas hosts and Canvas page URLs fall back to /login", () => {
  assert.deepEqual(parseInstitutionLink("canvas.school.edu"), { canvasOrigin: "https://canvas.school.edu", loginPath: "/login" });
  assert.deepEqual(parseInstitutionLink("  school.instructure.com/  "), { canvasOrigin: "https://school.instructure.com", loginPath: "/login" });
  assert.deepEqual(parseInstitutionLink("https://school.instructure.com/courses/1"), { canvasOrigin: "https://school.instructure.com", loginPath: "/login" });
});

test("vanity domains with a path keep only the origin and a valid login path", () => {
  assert.deepEqual(parseInstitutionLink("https://Canvas.Example.EDU/login/openid_connect/12/"), { canvasOrigin: "https://canvas.example.edu", loginPath: "/login/openid_connect/12" });
  assert.deepEqual(parseInstitutionLink("https://canvas.example.edu/dashboard"), { canvasOrigin: "https://canvas.example.edu", loginPath: "/login" });
});

test("supports CAS and the other Canvas auth providers", () => {
  assert.equal(parseInstitutionLink("https://school.instructure.com/login/cas/7").loginPath, "/login/cas/7");
  for (const path of ["/login", "/login/saml", "/login/cas", "/login/microsoft/4", "/login/google/1", "/login/ldap/2", "/login/canvas", "/login/clever/99", "/login/instructure", "/login/instructure/1863"])
    assert.equal(isValidCanvasLoginPath(path), true, path);
});

test("rejects http, credentials, ports, IPs and local hosts", () => {
  for (const value of [
    "http://school.instructure.com/login/saml/1", "https://user:pass@school.instructure.com/login", "https://school.instructure.com:8443/login",
    "https://127.0.0.1/login/saml", "10.0.0.1", "https://[::1]/login", "https://localhost/login", "localhost", "https://canvas.local/login",
    "javascript:alert(1)", "", "   ",
  ]) assert.throws(() => parseInstitutionLink(value), Error, value);
});

test("path traversal and odd login paths never become the navigation target", () => {
  assert.equal(isValidCanvasLoginPath("/login/../x"), false);
  assert.equal(parseInstitutionLink("https://school.instructure.com/login/../x").loginPath, "/login");
  assert.equal(parseInstitutionLink("https://school.instructure.com/login/%2e%2e/admin").loginPath, "/login");
  for (const path of ["/login/saml/abc", "/login/saml/1/2", "/login/evil", "//evil.example/login", "/login?x=1", "/login/saml/1234567890123", "/LOGIN/../", "https://x.edu/login", "/login/saml/1\n"])
    assert.equal(isValidCanvasLoginPath(path), false, JSON.stringify(path));
  assert.equal(toCanvasLoginPath("/login/evil"), "/login");
  assert.throws(() => requireCanvasLoginPath("/login/evil"), /sign-in path/);
  assert.equal(requireCanvasLoginPath(undefined), "/login");
});

test("query strings and fragments are stripped", () => {
  assert.deepEqual(parseInstitutionLink("https://ufl.instructure.com/login/saml/355?target=https://evil.example#frag"), { canvasOrigin: "https://ufl.instructure.com", loginPath: "/login/saml/355" });
});

test("discovered hosts merge after configured rules and never exceed eight", () => {
  const origin = "https://school.instructure.com";
  assert.deepEqual(mergeDiscoveredAuthHosts(["login.school.edu"], ["login.school.edu", "school.instructure.com", "idp.school.edu", "bad host"], origin), ["login.school.edu", "idp.school.edu"]);
  const seven = Array.from({ length: 7 }, (_, i) => `h${i}.school.edu`);
  assert.deepEqual(mergeDiscoveredAuthHosts(seven, ["a.example.com", "b.example.com"], origin), [...seven, "a.example.com"]);
  // Built-in trusted IdPs never take the last slot from an institution host.
  assert.deepEqual(mergeDiscoveredAuthHosts(seven, ["login.microsoftonline.com", "idp.school.edu"], origin), [...seven, "idp.school.edu"]);
});

test("orchestrator and integration script mirror the shared login-path predicate", async () => {
  for (const file of ["services/browser-orchestrator/server.mjs", "scripts/hosted-browser-integration.mjs"]) {
    const source = await readFile(file, "utf8");
    assert.ok(source.includes(`const CANVAS_LOGIN_PATH = ${CANVAS_LOGIN_PATH_PATTERN.toString()};`), file);
    assert.doesNotMatch(source, /=== "\/login\/saml" \? "\/login\/saml"/, file);
  }
});
