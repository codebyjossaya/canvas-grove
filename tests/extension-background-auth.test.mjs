import assert from "node:assert/strict";
import test from "node:test";

await import(`../extension/build.mjs?background-test-build=${Date.now()}`);
const { GROVE_ORIGIN } = await import("../extension/dist/config.js");

const ORIGIN = "https://school.instructure.com";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `gfe1.${DEVICE_ID}.${OWNER_ID}.${"a".repeat(43)}`;
let backgroundListener;

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function harness({ access = true } = {}) {
  const saved = new Map([["connection", { token: TOKEN, deviceName: "Test browser", canvasOrigin: null }]]);
  const opened = [];
  const groveRequests = [];
  const cookies = [
    { name: "canvas_session", value: "session-secret", domain: ".instructure.com", path: "/", session: true, httpOnly: true, secure: true, sameSite: "lax", storeId: "profile-7" },
    { name: "_csrf_token", value: "csrf", domain: "school.instructure.com", path: "/", session: true, secure: true, sameSite: "lax" },
    { name: "idp_session", value: "never-send", domain: "login.school.edu", path: "/", session: true, secure: true },
  ];
  let listener;
  let permission = access;
  globalThis.chrome = {
    runtime: {
      id: "extension-test-id",
      lastError: null,
      getURL: (path) => `chrome-extension://extension-test-id/${path}`,
      onMessage: { addListener: (value) => { listener = value; backgroundListener = value; } },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: saved.get(key) }),
        set: async (entries) => { for (const [key, value] of Object.entries(entries)) saved.set(key, value); },
        remove: async (key) => { for (const item of Array.isArray(key) ? key : [key]) saved.delete(item); },
      },
    },
    permissions: {
      contains: async () => permission,
      request: async () => permission,
    },
    tabs: { create: async ({ url }) => { opened.push(url); return { id: opened.length, url }; } },
    cookies: { getAll: async ({ url }) => { assert.equal(url, `${ORIGIN}/`); return cookies; }, set: async () => ({}) },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
  };
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value === `${ORIGIN}/api/v1/users/self`) return responseJson({ id: 42, name: "Ada Student" });
    if (value === `${GROVE_ORIGIN}/api/extension/canvas-auth`) {
      groveRequests.push({ url: value, init });
      return responseJson({ connected: true });
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };
  const sender = { id: "extension-test-id", tab: { id: 9 }, frameId: 0, url: `${GROVE_ORIGIN}/settings` };
  const send = (message) => new Promise((resolve, reject) => {
    const async = (listener ?? backgroundListener)(message, sender, resolve);
    if (!async) reject(new Error("background listener did not keep the response channel open"));
  });
  return { saved, opened, groveRequests, send, setPermission: (value) => { permission = value; } };
}

test("extension auth requires explicit capture, scopes cookies, and rejects replay", { concurrency: false }, async () => {
  const state = harness();
  await import(`../extension/dist/background.js?background-auth-test=${Date.now()}`);

  const opened = await state.send({ type: "canvas-auth-open", sessionId: SESSION_ID, canvasOrigin: ORIGIN, loginUrl: `${ORIGIN}/login` });
  assert.deepEqual(opened, { ok: true, reason: "opened", canvasOrigin: ORIGIN });
  assert.deepEqual(state.opened, [`${ORIGIN}/login`]);
  assert.equal(state.groveRequests.length, 0, "opening and detecting an account must never upload cookies");

  const checked = await state.send({ type: "canvas-auth-check", sessionId: SESSION_ID, canvasOrigin: ORIGIN });
  assert.deepEqual(checked, { ok: true, signedIn: true, account: { id: "42", name: "Ada Student" } });
  assert.equal(state.groveRequests.length, 0, "identity preview must remain local until the user confirms");

  const captured = await state.send({ type: "canvas-auth-capture", sessionId: SESSION_ID, canvasOrigin: ORIGIN });
  assert.deepEqual(captured, { ok: true, reason: "captured", canvasOrigin: ORIGIN });
  assert.equal(state.groveRequests.length, 1);
  const request = state.groveRequests[0];
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(request.init.body);
  assert.equal(body.sessionId, SESSION_ID);
  assert.equal(body.canvasOrigin, ORIGIN);
  assert.deepEqual(body.cookies.map((cookie) => cookie.name), ["canvas_session", "_csrf_token"]);
  assert.ok(body.cookies.every((cookie) => cookie.domain === "school.instructure.com"));
  assert.ok(body.cookies.every((cookie) => !("storeId" in cookie)));
  assert.equal(state.saved.has("pendingCanvasAuth"), false);

  const replay = await state.send({ type: "canvas-auth-capture", sessionId: SESSION_ID, canvasOrigin: ORIGIN });
  assert.deepEqual(replay, { ok: false, reason: "auth-mismatch" });
  assert.equal(state.groveRequests.length, 1, "a cleared attempt cannot upload a second jar");
});

test("extension auth does not create a pending attempt when exact-origin access is denied", { concurrency: false }, async () => {
  const state = harness({ access: false });
  const result = await state.send({ type: "canvas-auth-open", sessionId: SESSION_ID, canvasOrigin: ORIGIN, loginUrl: `${ORIGIN}/login` });
  assert.deepEqual(result, { ok: false, reason: "permission-required", canvasOrigin: ORIGIN });
  assert.equal(state.saved.has("pendingCanvasAuth"), false);
  assert.equal(state.saved.get("connection").canvasOrigin, ORIGIN, "the popup needs the exact requested origin to present its permission button");
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.groveRequests, []);
});

test("extension auth clears a stale local capture attempt without reading cookies", { concurrency: false }, async () => {
  const state = harness();
  await state.send({ type: "canvas-auth-open", sessionId: SESSION_ID, canvasOrigin: ORIGIN, loginUrl: `${ORIGIN}/login` });
  state.saved.set("pendingCanvasAuth", { ...state.saved.get("pendingCanvasAuth"), startedAt: Date.now() - 31 * 60 * 1000 });
  const result = await state.send({ type: "canvas-auth-check", sessionId: SESSION_ID, canvasOrigin: ORIGIN });
  assert.deepEqual(result, { ok: false, reason: "auth-expired" });
  assert.equal(state.saved.has("pendingCanvasAuth"), false);
  assert.deepEqual(state.groveRequests, []);
});
