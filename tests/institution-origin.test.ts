import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isAllowedInstitutionUrl, normalizeAuthHostRules, normalizeCanvasOrigin, normalizeInstitutionName, toCanvasLoginPath } from "../lib/canvas/institution";
import { isPublicAddress } from "../lib/canvas/network-policy";

test("SSRF policy rejects private and special-use addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::ffff:192.168.1.1"])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address), true, address);
});

test("normalizes hosted and custom Canvas origins without assuming a university", () => {
  assert.equal(normalizeCanvasOrigin("northwestern.instructure.com/"), "https://northwestern.instructure.com");
  assert.equal(normalizeCanvasOrigin("https://canvas.example.edu"), "https://canvas.example.edu");
  assert.equal(normalizeInstitutionName("", "https://northwestern.instructure.com"), "Northwestern");
  assert.equal(normalizeInstitutionName("Example State University", "https://canvas.example.edu"), "Example State University");
  assert.equal(toCanvasLoginPath("/login/saml"), "/login/saml");
  assert.equal(toCanvasLoginPath("/login/saml/355"), "/login/saml/355");
  assert.equal(toCanvasLoginPath("anything-else"), "/login");
});

test("rejects local, private-shaped, credentialed, non-HTTPS, port, and path origins", () => {
  for (const value of [
    "http://school.instructure.com", "https://user:pass@school.instructure.com", "https://school.instructure.com:8443",
    "https://school.instructure.com/courses", "https://localhost", "https://canvas.local", "https://127.0.0.1", "https://[::1]",
  ]) assert.throws(() => normalizeCanvasOrigin(value), /Canvas|HTTPS|host|IP|Local|origin/i, value);
});

test("auth domains are exact scoped hosts and cannot escape between institutions", () => {
  const originA = normalizeCanvasOrigin("https://a.instructure.com");
  const originB = normalizeCanvasOrigin("https://canvas.b.edu");
  const rulesA = normalizeAuthHostRules("login.a.edu, mfa.example.com", originA);
  assert.deepEqual(rulesA, ["login.a.edu", "mfa.example.com"]);
  assert.equal(isAllowedInstitutionUrl(`${originA}/login`, originA, rulesA), true);
  assert.equal(isAllowedInstitutionUrl("https://sso.login.a.edu/start", originA, rulesA), false);
  assert.equal(isAllowedInstitutionUrl("https://mfa.example.com/prompt", originA, rulesA), true);
  assert.equal(isAllowedInstitutionUrl(`${originB}/login`, originA, rulesA), false);
  assert.equal(isAllowedInstitutionUrl("https://evillogin.a.edu.attacker.test/", originA, rulesA), false);
  assert.equal(isAllowedInstitutionUrl("http://login.a.edu/", originA, rulesA), false);
  assert.equal(isAllowedInstitutionUrl("https://login.a.edu:8443/", originA, rulesA), false);
});

test("university-specific runtime allowlists and copy are absent", async () => {
  const files = await Promise.all([
    "components/ui/canvas-session.tsx", "components/ui/orientation.tsx", "lib/bridge/providers/self-hosted.ts", "services/browser-orchestrator/server.mjs",
  ].map((path) => readFile(path, "utf8")));
  const source = files.join("\n");
  assert.doesNotMatch(source, /GatorLink|Opening UF|finish GatorLink|host === "ufl\.edu"|endsWith\("\.ufl\.edu"\)/i);
  assert.match(source, /authHostRules/);
  assert.match(source, /institutionName/);
});

test("migration backfills the existing account without revoking or relinking it", async () => {
  const migration = await readFile("drizzle/0006_nervous_unus.sql", "utf8");
  assert.match(migration, /University of Florida/);
  assert.match(migration, /ufl\.edu/);
  assert.match(migration, /login\/saml/);
  assert.doesNotMatch(migration, /delete\s+from|update\s+"hosted_browser_sessions"|revoked_at/i);
});
