import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedInstitutionUrl, normalizeAuthHostRules } from "../lib/canvas/institution";

const canvas = "https://ufl.instructure.com";

test("reviewed UF Canvas SSO chain is added exactly", () => {
  assert.deepEqual(normalizeAuthHostRules([], canvas), ["elearning.ufl.edu", "login.ufl.edu"]);
  assert.equal(isAllowedInstitutionUrl("https://elearning.ufl.edu/", canvas, normalizeAuthHostRules([], canvas)), true);
  assert.equal(isAllowedInstitutionUrl("https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO?opaque=redacted", canvas, normalizeAuthHostRules([], canvas)), true);
  assert.equal(isAllowedInstitutionUrl("https://sub.login.ufl.edu/", canvas, normalizeAuthHostRules([], canvas)), false);
});

test("legacy broad UF rule is pruned instead of bypassing exact reviewed hosts", () => {
  const rules = normalizeAuthHostRules(["ufl.edu"], canvas);
  assert.deepEqual(rules, ["elearning.ufl.edu", "login.ufl.edu"]);
  assert.equal(isAllowedInstitutionUrl("https://random.ufl.edu/", canvas, rules), false);
});

test("lookalikes, insecure schemes, credentials, ports, and private hosts stay blocked", () => {
  const rules = normalizeAuthHostRules([], canvas);
  for (const value of [
    "https://elearning.ufl.edu.evil.example/",
    "https://ufl.edu.evil.example/",
    "http://login.ufl.edu/",
    "https://user:pass@login.ufl.edu/",
    "https://login.ufl.edu:8443/",
    "https://127.0.0.1/",
    "https://metadata.google.internal/",
  ]) assert.equal(isAllowedInstitutionUrl(value, canvas, rules), false, value);
});

test("UF's Duo and Microsoft hops are allowed via the built-in IdP list, not via user rules", () => {
  const rules = normalizeAuthHostRules([], canvas);
  assert.equal(rules.length, 2);
  assert.equal(isAllowedInstitutionUrl("https://api-abc123.duosecurity.com/frame/frameless/v4/auth", canvas, rules), true);
  assert.equal(isAllowedInstitutionUrl("https://login.microsoftonline.com/common/saml2", canvas, rules), true);
  assert.equal(isAllowedInstitutionUrl("https://evil-duosecurity.com/", canvas, rules), false);
  assert.equal(isAllowedInstitutionUrl("https://duosecurity.com.evil.net/", canvas, rules), false);
  assert.equal(isAllowedInstitutionUrl("https://cdnjs.cloudflare.com/ajax/libs/x.js", canvas, rules), false);
  assert.throws(() => normalizeAuthHostRules(["*.duosecurity.com"], canvas), /Wildcard/);
});

test("unrelated institutions do not inherit UF hosts", () => {
  const other = "https://example.instructure.com";
  assert.deepEqual(normalizeAuthHostRules([], other), []);
  assert.equal(isAllowedInstitutionUrl("https://login.ufl.edu/", other, []), false);
});
