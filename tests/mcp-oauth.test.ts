import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  bearerUsable, checkCodeExchange, checkRefresh, parseScope, patExpiryDays, pkceChallenge, redirectRegistered, resourceMatches,
  validRedirectUri, validateRegistration, verifyPkce, type CodeRow, type RefreshRow,
} from "../lib/mcp/oauth-policy";

const SERVER = "https://grove.example/mcp";
const verifier = randomBytes(32).toString("base64url");
const challenge = pkceChallenge(verifier);
const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 1_000).toISOString();

test("PKCE S256 verifies only the matching verifier and rejects malformed input", () => {
  // RFC 7636 appendix B test vector
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce(randomBytes(32).toString("base64url"), challenge), false);
  assert.equal(verifyPkce("short", pkceChallenge("short")), false);
  assert.equal(verifyPkce(verifier, verifier.slice(0, 43)), false);
  assert.equal(verifyPkce(undefined, challenge), false);
  assert.equal(verifyPkce("a".repeat(129), pkceChallenge("a".repeat(129))), false);
});

test("redirect URIs: https anywhere, http only on loopback, exact match", () => {
  for (const ok of ["https://claude.ai/api/mcp/auth_callback", "http://localhost:33418/callback", "http://127.0.0.1/cb", "http://[::1]:8080/cb", "https://chatgpt.com/connector_platform_oauth_redirect"])
    assert.equal(validRedirectUri(ok), true, ok);
  for (const bad of ["http://example.com/cb", "https://x.com/cb#frag", "https://user:pw@x.com/cb", "javascript:alert(1)", "cursor://anysphere/cb", "https://x.com/a b", "", "http://localhost.evil.com/cb", "https://" + "a".repeat(600) + ".com", 5])
    assert.equal(validRedirectUri(bad), false, String(bad));
  const registered = ["https://a.example/cb"];
  assert.equal(redirectRegistered(registered, "https://a.example/cb"), true);
  assert.equal(redirectRegistered(registered, "https://a.example/cb/"), false);
  assert.equal(redirectRegistered(registered, "https://A.example/cb"), false);
  assert.equal(redirectRegistered(registered, "https://a.example/cb?x=1"), false);
});

test("dynamic client registration validation", () => {
  const ok = validateRegistration({ client_name: " Claude <x> ", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  assert.ok(ok.ok);
  assert.ok(ok.ok && ok.value.clientName === "Claude x");
  assert.equal(validateRegistration({ redirect_uris: [] }).ok, false);
  assert.equal(validateRegistration({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) }).ok, false);
  assert.equal(validateRegistration({ redirect_uris: ["http://evil.example/cb"] }).ok, false);
  assert.equal(validateRegistration({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }).ok, false);
  assert.equal(validateRegistration({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] }).ok, false);
  assert.equal(validateRegistration({ redirect_uris: ["https://a.example/cb"], scope: "canvas:write" }).ok, true);
  assert.equal(validateRegistration({ redirect_uris: ["https://a.example/cb"], scope: "canvas:admin" }).ok, false);
  assert.equal(validateRegistration([]).ok, false);
  const long = validateRegistration({ client_name: "n".repeat(500), redirect_uris: ["https://a.example/cb"] });
  assert.ok(long.ok && long.value.clientName.length === 100);
});

test("scope handling: default, supported, reserved and unknown", () => {
  assert.deepEqual(parseScope(undefined), { ok: true, scopes: ["canvas:read"] });
  assert.deepEqual(parseScope(""), { ok: true, scopes: ["canvas:read"] });
  assert.deepEqual(parseScope("canvas:read canvas:read"), { ok: true, scopes: ["canvas:read"] });
  assert.deepEqual(parseScope("canvas:read canvas:write"), { ok: true, scopes: ["canvas:read", "canvas:write"] });
  assert.equal(parseScope("canvas:admin").ok, false);
  assert.equal(parseScope("canvas:read openid").ok, false);
  assert.equal(parseScope("x".repeat(300)).ok, false);
  assert.equal(resourceMatches(undefined, SERVER), true);
  assert.equal(resourceMatches("https://grove.example/mcp/", SERVER), true);
  assert.equal(resourceMatches("https://evil.example/mcp", SERVER), false);
  assert.equal(resourceMatches("https://grove.example/", SERVER), false);
  assert.equal(patExpiryDays(undefined), 90);
  assert.equal(patExpiryDays(null), null);
  assert.equal(patExpiryDays(365), 365);
  assert.equal(patExpiryDays(7), undefined);
  assert.equal(patExpiryDays("30"), undefined);
});

const code = (over: Partial<CodeRow> = {}): CodeRow => ({ client_id: "gmcl_a", redirect_uri: "https://a.example/cb", code_challenge: challenge, resource: SERVER, expires_at: future, used_at: null, grant_revoked_at: null, ...over });
const codeReq = { clientId: "gmcl_a", redirectUri: "https://a.example/cb", codeVerifier: verifier, resource: SERVER };

test("authorization code lifecycle: bound to client, redirect, PKCE, resource; single use; TTL", () => {
  assert.deepEqual(checkCodeExchange(code(), codeReq, SERVER), { ok: true });
  assert.deepEqual(checkCodeExchange(code(), { ...codeReq, resource: undefined }, SERVER), { ok: true });
  assert.equal(checkCodeExchange(null, codeReq, SERVER).ok, false);
  const replay = checkCodeExchange(code({ used_at: past }), codeReq, SERVER);
  assert.ok(!replay.ok && replay.replay === true && replay.error === "invalid_grant");
  assert.equal(checkCodeExchange(code({ expires_at: past }), codeReq, SERVER).ok, false);
  assert.equal(checkCodeExchange(code({ grant_revoked_at: past }), codeReq, SERVER).ok, false);
  assert.equal(checkCodeExchange(code(), { ...codeReq, clientId: "gmcl_b" }, SERVER).ok, false);
  assert.equal(checkCodeExchange(code(), { ...codeReq, redirectUri: "https://a.example/cb/" }, SERVER).ok, false);
  assert.equal(checkCodeExchange(code(), { ...codeReq, redirectUri: undefined }, SERVER).ok, false);
  assert.equal(checkCodeExchange(code(), { ...codeReq, codeVerifier: randomBytes(32).toString("base64url") }, SERVER).ok, false);
  const target = checkCodeExchange(code(), { ...codeReq, resource: "https://evil.example/mcp" }, SERVER);
  assert.ok(!target.ok && target.error === "invalid_target");
  const now = Date.now();
  assert.equal(checkCodeExchange(code({ expires_at: new Date(now + 5 * 60_000).toISOString() }), codeReq, SERVER, now + 5 * 60_000 + 1).ok, false);
});

const refresh = (over: Partial<RefreshRow> = {}): RefreshRow => ({ kind: "refresh", client_id: "gmcl_a", scopes: ["canvas:read"], expires_at: future, consumed_at: null, revoked_at: null, grant_revoked_at: null, ...over });

test("refresh rotation with reuse detection", () => {
  assert.deepEqual(checkRefresh(refresh(), { clientId: "gmcl_a", scope: undefined }), { ok: true, scopes: ["canvas:read"] });
  const reuse = checkRefresh(refresh({ consumed_at: past }), { clientId: "gmcl_a", scope: undefined });
  assert.ok(!reuse.ok && reuse.replay === true);
  // reuse is detected even when presented by another client id
  const foreign = checkRefresh(refresh({ consumed_at: past }), { clientId: "gmcl_b", scope: undefined });
  assert.ok(!foreign.ok && foreign.replay === true);
  assert.equal(checkRefresh(refresh({ kind: "access" }), { clientId: "gmcl_a", scope: undefined }).ok, false);
  assert.equal(checkRefresh(refresh({ revoked_at: past }), { clientId: "gmcl_a", scope: undefined }).ok, false);
  assert.equal(checkRefresh(refresh({ grant_revoked_at: past }), { clientId: "gmcl_a", scope: undefined }).ok, false);
  assert.equal(checkRefresh(refresh({ expires_at: past }), { clientId: "gmcl_a", scope: undefined }).ok, false);
  assert.equal(checkRefresh(refresh(), { clientId: "gmcl_b", scope: undefined }).ok, false);
  assert.equal(checkRefresh(refresh(), { clientId: undefined, scope: undefined }).ok, false);
  const widen = checkRefresh(refresh(), { clientId: "gmcl_a", scope: "canvas:write" });
  assert.ok(!widen.ok && widen.error === "invalid_scope");
  assert.equal(checkRefresh(null, { clientId: "gmcl_a", scope: undefined }).ok, false);
});

test("bearer usability: kinds, expiry, revocation", () => {
  assert.equal(bearerUsable({ kind: "pat", expires_at: null, revoked_at: null, grant_revoked_at: null }), true);
  assert.equal(bearerUsable({ kind: "access", expires_at: future, revoked_at: null, grant_revoked_at: null }), true);
  assert.equal(bearerUsable({ kind: "access", expires_at: past, revoked_at: null, grant_revoked_at: null }), false);
  assert.equal(bearerUsable({ kind: "access", expires_at: future, revoked_at: null, grant_revoked_at: past }), false);
  assert.equal(bearerUsable({ kind: "pat", expires_at: future, revoked_at: past, grant_revoked_at: null }), false);
  assert.equal(bearerUsable({ kind: "refresh", expires_at: future, revoked_at: null, grant_revoked_at: null }), false);
  assert.equal(bearerUsable(null), false);
});
