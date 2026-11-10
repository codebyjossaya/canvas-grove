import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as shared from "../services/browser-network-policy.mjs";
import * as orchestrator from "../services/browser-orchestrator/navigation-policy.mjs";
import * as app from "../lib/canvas/trusted-identity-hosts.ts";
import { isAllowedInstitutionUrl, normalizeAuthHostRules } from "../lib/canvas/institution.ts";

const canvas = "https://example.instructure.com";
const rules = ["login.example.edu"];

// The four enforcement points, each as a "may this be a top-level page?" predicate.
const navigation = {
  app: (url) => isAllowedInstitutionUrl(url, canvas, rules),
  orchestrator: (url) => orchestrator.allowedInteractiveUrl(url, canvas, rules),
  relay: (url) => shared.allowedNavigationUrl(url, canvas, rules),
  // The proxy only sees hostnames; for navigation-class hosts it must agree.
  proxy: (url) => shared.egressHostAllowed(new URL(url).hostname, new Set(["example.instructure.com", ...rules])),
};

test("trusted identity-provider lists are identical in every copy", () => {
  assert.deepEqual([...orchestrator.TRUSTED_IDENTITY_PROVIDER_SUFFIXES], [...shared.TRUSTED_IDENTITY_PROVIDER_SUFFIXES]);
  assert.deepEqual([...app.TRUSTED_IDENTITY_PROVIDER_SUFFIXES], [...shared.TRUSTED_IDENTITY_PROVIDER_SUFFIXES]);
  for (const list of [shared.TRUSTED_IDENTITY_PROVIDER_SUFFIXES, shared.EGRESS_ONLY_SUFFIXES, shared.EGRESS_ONLY_EXACT_HOSTS]) {
    assert.ok(Object.isFrozen(list));
    for (const entry of list) assert.match(entry, /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, entry);
    assert.equal(new Set(list).size, list.length);
  }
  // Egress-only hosts must never leak into the navigation list.
  for (const entry of [...shared.EGRESS_ONLY_SUFFIXES, ...shared.EGRESS_ONLY_EXACT_HOSTS]) assert.equal(shared.isTrustedIdentityHost(entry), false, entry);
});

test("Duo per-tenant API host and other IdP tenants are navigable in all four implementations", () => {
  for (const url of [
    "https://api-abc123.duosecurity.com/frame/frameless/v4/auth?sid=redacted",
    "https://login.microsoftonline.com/common/saml2",
    "https://school.okta.com/app/canvas/sso/saml",
    "https://accounts.google.com/o/saml2/idp?idpid=x",
    `${canvas}/login/saml`,
    "https://login.example.edu/idp/profile/SAML2/Redirect/SSO",
  ]) for (const [name, allowed] of Object.entries(navigation)) assert.equal(allowed(url), true, `${name}: ${url}`);
});

test("lookalike and unrelated hosts are rejected in all four implementations", () => {
  for (const url of [
    "https://evil-duosecurity.com/",
    "https://duosecurity.com.evil.net/",
    "https://api-abc123.duosecurity.com.evil.net/",
    "https://notokta.com/",
    "https://okta.com.attacker.test/",
    "https://sub.login.example.edu/",
    "https://other.instructure.com/",
    "https://www.googletagmanager.com/gtm.js",
  ]) for (const [name, allowed] of Object.entries(navigation)) assert.equal(allowed(url), false, `${name}: ${url}`);
  for (const [name, allowed] of Object.entries(navigation).filter(([n]) => n !== "proxy")) {
    for (const url of ["http://api-abc123.duosecurity.com/", "https://api-abc123.duosecurity.com:8443/", "https://u:p@school.okta.com/"]) assert.equal(allowed(url), false, `${name}: ${url}`);
  }
});

test("egress-only CDNs are allowed for CONNECT but never for top-level navigation", () => {
  const exact = new Set(["example.instructure.com"]);
  for (const host of ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "ajax.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com", "aadcdn.msauth.net", "aadcdn.msftauth.net", "logincdn.msauth.net", "ok1static.oktacdn.com", "du11hjcvx0uqb.cloudfront.net", "instructure-uploads.s3.amazonaws.com"]) {
    assert.equal(shared.egressHostAllowed(host, exact), true, host);
    for (const [name, allowed] of Object.entries(navigation).filter(([n]) => n !== "proxy")) assert.equal(allowed(`https://${host}/x.js`), false, `${name}: ${host}`);
  }
});

test("trackers, shared-hosting lookalikes and unregistered hosts stay blocked at egress", () => {
  const exact = new Set(["example.instructure.com"]);
  for (const host of ["www.googletagmanager.com", "googletagmanager.com", "www.google-analytics.com", "evil.cloudfront.net", "x.du11hjcvx0uqb.cloudfront.net", "evil.instructure-uploads.s3.amazonaws.com", "evil-cdnjs.cloudflare.com", "cdnjs.cloudflare.com.evil.net", "attacker.example"]) {
    assert.equal(shared.egressHostAllowed(host, exact), false, host);
  }
});

test("user rules stay exact: wildcards are rejected, never suffix matched", () => {
  assert.throws(() => normalizeAuthHostRules(["*.duosecurity.com"], canvas), /Wildcard/);
  assert.throws(() => normalizeAuthHostRules("*.example.edu", canvas), /Wildcard/);
  const exactOnly = normalizeAuthHostRules(["example.edu"], canvas);
  assert.equal(isAllowedInstitutionUrl("https://login.example.edu/", canvas, exactOnly), false);
  assert.equal(orchestrator.allowedInteractiveUrl("https://login.example.edu/", canvas, exactOnly), false);
  assert.equal(shared.allowedNavigationUrl("https://login.example.edu/", canvas, exactOnly), false);
  assert.equal(shared.egressHostAllowed("login.example.edu", new Set(exactOnly)), false);
});

test("proxy holds the suffix lists itself and still rejects registered suffixes and non-public DNS", () => {
  const proxy = readFileSync("services/browser-egress-proxy/server.mjs", "utf8");
  const relay = readFileSync("services/browser-relay/server.mjs", "utf8");
  const orchestratorSource = readFileSync("services/browser-orchestrator/server.mjs", "utf8");
  assert.match(proxy, /import \{[^}]*egressHostAllowed[^}]*\} from "\.\/browser-network-policy\.mjs"/);
  assert.match(proxy, /v\.suffixes!==undefined/);
  assert.match(proxy, /rows\.every\([^)]*isPublicAddress/);
  assert.match(relay, /import \{ allowedNavigationUrl \} from "\.\/browser-network-policy\.mjs"/);
  assert.match(relay, /registerEgress\(value\.target,\[canvasHost,\.\.\.value\.authHostRules\]\)/);
  assert.match(orchestratorSource, /import \{ allowedInteractiveUrl \} from "\.\/navigation-policy\.mjs"/);
  assert.doesNotMatch(orchestratorSource, /function allowedInteractiveUrl/);
});
