import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canvasUserIdFromVerification, normalizeCapturedCookies } from "../lib/extension/canvas-auth-contract";

const ORIGIN = "https://ufl.instructure.com";
const NOW = 1_800_000_000;
const session = { name: "canvas_session", value: "secret", domain: "ufl.instructure.com", path: "/", expires: NOW + 60, httpOnly: true, secure: true, sameSite: "Lax" };

test("captured Canvas cookies accept an exact-origin live session", () => {
  assert.deepEqual(normalizeCapturedCookies([session], ORIGIN, NOW), [session]);
});

test("captured cookies reject foreign scope, missing session, expiry and header injection", () => {
  assert.throws(() => normalizeCapturedCookies([{ ...session, domain: "login.ufl.edu" }], ORIGIN, NOW), /limited to the Canvas site/);
  assert.throws(() => normalizeCapturedCookies([{ ...session, name: "_csrf_token" }], ORIGIN, NOW), /No live Canvas session/);
  assert.throws(() => normalizeCapturedCookies([{ ...session, expires: NOW - 1 }], ORIGIN, NOW), /expired/);
  assert.throws(() => normalizeCapturedCookies([{ ...session, value: "x; injected=y" }], ORIGIN, NOW), /invalid cookie/);
});

test("captured cookie count and aggregate size are bounded", () => {
  assert.throws(() => normalizeCapturedCookies(Array.from({ length: 65 }, (_, i) => ({ ...session, name: `c${i}` })), ORIGIN, NOW), /invalid/);
  assert.throws(() => normalizeCapturedCookies([session, { ...session, name: "large", value: "x".repeat(16_385) }], ORIGIN, NOW), /invalid cookie/);
});

test("server verification accepts only a successful numeric Canvas identity", () => {
  assert.equal(canvasUserIdFromVerification({ ok: true, authRequired: false, data: { id: 42 } }), "42");
  assert.throws(() => canvasUserIdFromVerification({ ok: false, authRequired: false, data: { id: 42 } }), /did not accept/);
  assert.throws(() => canvasUserIdFromVerification({ ok: true, authRequired: true, data: { id: 42 } }), /did not accept/);
  assert.throws(() => canvasUserIdFromVerification({ ok: true, authRequired: false, data: { id: "not-a-user" } }), /did not accept/);
});

test("captured state is committed only after independent Canvas verification", () => {
  const activation = readFileSync(new URL("../lib/extension/canvas-auth.ts", import.meta.url), "utf8");
  const commit = activation.indexOf("const connected = await withTenantSql");
  assert.ok(activation.indexOf("interactiveAttemptDeadlineAt <= Date.now()") < activation.indexOf("const cookies = normalizeCapturedCookies"));
  assert.ok(activation.indexOf('path: "/api/v1/users/self"') < commit);
  assert.ok(activation.indexOf("canvasUserIdFromVerification(verified)") < commit);

  const finalizer = readFileSync(new URL("../lib/bridge/complete-authentication.ts", import.meta.url), "utf8");
  assert.match(finalizer, /status in \('provisioning','auth_required'\)/);
  assert.doesNotMatch(finalizer, /status in \('provisioning','auth_required','expired'\)/);
  assert.match(finalizer, /status='active'[\s\S]*return replay\.length === 1/);
});
