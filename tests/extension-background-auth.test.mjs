import assert from "node:assert/strict";
import test from "node:test";

await import(`../extension/build.mjs?background-test-build=${Date.now()}`);
const { GROVE_ORIGIN, GROVE_PATTERN } = await import("../extension/dist/config.js");

const ORIGIN = "https://school.instructure.com";
const LOGIN = `${ORIGIN}/login`;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `gfe1.${DEVICE_ID}.${OWNER_ID}.${"a".repeat(43)}`;
const EXT_ID = "extension-test-id";
const EXT = `chrome-extension://${EXT_ID}/`;
const GROVE_TAB = 9;
const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let imports = 0;

const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const responseJson = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function listeners() {
  const set = [];
  return { set, addListener: (fn) => { set.push(fn); }, fire: (...args) => set.map((fn) => fn(...args)) };
}

const SESSION_JAR = () => [
  { name: "canvas_session", value: "session-secret", domain: ".instructure.com", path: "/", session: true, httpOnly: true, secure: true, sameSite: "lax", storeId: "profile-7" },
  { name: "_csrf_token", value: "csrf", domain: "school.instructure.com", path: "/", session: true, secure: true, sameSite: "lax" },
  { name: "idp_session", value: "never-send", domain: "login.school.edu", path: "/", session: true, secure: true },
];

/**
 * A stubbed chrome.* + fetch. `session`, `local` and `tabs` can be shared between two harnesses to
 * simulate a service-worker restart (storage.session and open tabs survive; module state does not).
 */
function harness({ access = true, signedIn = false, captureStatus = 200, captureBody = { connected: true }, selfPrefix = "", session, local, tabs, jar, paired = true } = {}) {
  const state = {
    signedIn, permission: access, probes: 0, log: [], created: [], panels: [], injected: [], groveRequests: [], tabMessages: [], pageMessages: [], intervals: [], offset: 0,
    session: session ?? new Map(),
    local: local ?? new Map(paired ? [["connection", { token: TOKEN, deviceName: "Test browser", canvasOrigin: null }]] : []),
    tabs: tabs ?? new Map([[GROVE_TAB, { id: GROVE_TAB, index: 3, windowId: 1, url: `${GROVE_ORIGIN}/welcome` }]]),
  };
  let nextTab = Math.max(100, ...state.tabs.keys()) + 1;
  const ev = {
    onMessage: listeners(), onInstalled: listeners(), onStartup: listeners(), onRemoved: listeners(), onUpdated: listeners(),
    completed: listeners(), headers: listeners(), storageChanged: listeners(), permAdded: listeners(), permRemoved: listeners(),
  };
  const area = (map) => ({
    get: async (key) => ({ [key]: map.get(key) }),
    set: async (entries) => { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    remove: async (key) => { for (const item of Array.isArray(key) ? key : [key]) map.delete(item); },
  });
  globalThis.chrome = {
    runtime: {
      id: EXT_ID, lastError: null,
      getURL: (path) => `${EXT}${path}`,
      getManifest: () => ({ version: "0.4.0" }),
      onMessage: ev.onMessage, onInstalled: ev.onInstalled, onStartup: ev.onStartup,
      sendMessage: async (message) => { state.pageMessages.push(message); },
    },
    storage: { local: area(state.local), session: area(state.session), onChanged: ev.storageChanged },
    permissions: { contains: async () => state.permission, request: async () => state.permission, onAdded: ev.permAdded, onRemoved: ev.permRemoved },
    tabs: {
      create: async (options) => {
        const tab = { id: nextTab++, index: options.index ?? 0, windowId: options.windowId ?? 1, url: options.url, openerTabId: options.openerTabId, active: options.active };
        state.tabs.set(tab.id, tab); state.created.push(tab); state.log.push(`tabs.create:${tab.url}`);
        return tab;
      },
      remove: async (id) => {
        state.log.push(`tabs.remove:${id}`);
        if (!state.tabs.delete(id)) throw new Error("No tab with id");
        ev.onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
      },
      update: async (id, props) => {
        const tab = state.tabs.get(id);
        if (!tab) throw new Error("No tab with id");
        Object.assign(tab, props);
        state.log.push(`tabs.update:${id}:${props.url ?? (props.active ? "active" : "")}`);
        return tab;
      },
      get: async (id) => { const tab = state.tabs.get(id); if (!tab) throw new Error("No tab with id"); return tab; },
      query: async ({ url }) => { assert.equal(url, GROVE_PATTERN); return [...state.tabs.values()].filter((tab) => String(tab.url).startsWith(GROVE_ORIGIN)); },
      sendMessage: async (tabId, message) => { state.tabMessages.push({ tabId, message }); },
      onRemoved: ev.onRemoved, onUpdated: ev.onUpdated,
    },
    windows: { update: async (id) => { state.log.push(`windows.update:${id}`); } },
    sidePanel: { setOptions: async (options) => { state.panels.push(options); }, open: async () => undefined },
    scripting: { executeScript: async (options) => { state.injected.push(options); } },
    webRequest: { onCompleted: ev.completed, onHeadersReceived: ev.headers },
    cookies: {
      getAll: async ({ url }) => { assert.equal(url, `${ORIGIN}/`); state.log.push("cookies.getAll"); return jar ?? SESSION_JAR(); },
      set: async () => ({}),
    },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
  };
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value === `${ORIGIN}/api/v1/users/self`) {
      state.probes += 1; state.log.push("probe");
      return state.signedIn ? new Response(selfPrefix + JSON.stringify({ id: 42, name: "Ada Student" }), { status: 200 }) : new Response("", { status: 401 });
    }
    if (value === `${GROVE_ORIGIN}/api/extension/canvas-auth`) {
      state.log.push("upload"); state.groveRequests.push({ url: value, init });
      return responseJson(captureBody, captureStatus);
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };
  // The background's 2 s fallback poll runs on these fake intervals; tests fire them with tick().
  globalThis.setInterval = (fn) => { state.intervals.push(fn); return state.intervals.length; };
  globalThis.clearInterval = (id) => { if (typeof id === "number") state.intervals[id - 1] = null; };
  Date.now = () => realNow() + state.offset;

  state.ev = ev;
  state.grove = (path = "/welcome") => ({ id: EXT_ID, tab: state.tabs.get(GROVE_TAB) ?? { id: GROVE_TAB, index: 3, windowId: 1 }, frameId: 0, url: `${GROVE_ORIGIN}${path}` });
  state.page = (name, tabId) => ({ id: EXT_ID, url: `${EXT}${name}.html?s=${SESSION_ID}`, ...(tabId ? { tab: { id: tabId } } : {}) });
  state.send = (message, sender = state.grove()) => new Promise((resolve) => {
    const keep = ev.onMessage.set.at(-1)(message, sender, resolve);
    if (!keep) resolve(undefined);
  });
  state.load = async () => { await import(`../extension/dist/background.js?background-auth-test=${++imports}`); await settle(); };
  state.tick = async () => { for (const fn of state.intervals) if (fn) fn(); await settle(); };
  state.request = async (event, details) => { state.ev[event].fire(details); await settle(); };
  state.status = (sessionId = SESSION_ID) => state.send({ type: "signin-status", sessionId });
  state.stages = (sessionId = SESSION_ID) => state.tabMessages
    .flatMap(({ message }) => message.events.filter((event) => event.type === "signin" && event.status.sessionId === sessionId).map((event) => event.status.stage))
    .filter((stage, index, all) => stage !== all[index - 1]);
  state.index = (entry) => state.log.indexOf(entry);
  return state;
}

const START = { type: "signin-start", sessionId: SESSION_ID, canvasOrigin: ORIGIN, loginUrl: LOGIN, schoolName: "School University" };

async function startAndContinue(state) {
  assert.deepEqual(await state.send(START), { ok: true });
  const tab = state.created.at(-1);
  await state.send({ type: "signin-page", sessionId: SESSION_ID }, state.page("signin", tab.id));
  assert.deepEqual(await state.send({ type: "signin-continue", sessionId: SESSION_ID }, state.page("signin", tab.id)), { ok: true });
  await settle();
  return tab;
}

test.afterEach(() => { Date.now = realNow; globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; });

test("signin-start opens the interstitial in a new tab beside Grove with a tab-scoped side panel", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  assert.deepEqual(await state.send(START), { ok: true });
  const [tab] = state.created;
  assert.equal(tab.url, `${EXT}signin.html?s=${SESSION_ID}`);
  assert.deepEqual([tab.index, tab.openerTabId, tab.windowId, tab.active], [4, GROVE_TAB, 1, true]);
  assert.deepEqual(state.panels, [{ tabId: tab.id, path: `sidepanel.html?s=${SESSION_ID}`, enabled: true }], "the panel is enabled for the sign-in tab only");
  assert.equal((await state.status()).stage, "opening");
  assert.equal(state.probes, 0);
  assert.equal(state.index("cookies.getAll"), -1, "opening never reads cookies");
  assert.equal(state.groveRequests.length, 0);
  const events = state.tabMessages.filter(({ tabId }) => tabId === GROVE_TAB).flatMap(({ message }) => message.events);
  assert.ok(events.some((event) => event.type === "signin" && event.status.stage === "opening"));
  const stateEvent = events.find((event) => event.type === "state");
  assert.equal(stateEvent.state.protocol, 2);
  assert.equal(stateEvent.state.signin.sessionId, SESSION_ID);
  assert.ok(!state.log.some((entry) => entry.startsWith("windows.create")), "no popup window");
});

test("hello reports protocol v2 state", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  assert.deepEqual(await state.send({ type: "hello" }), {
    installed: true, protocol: 2, version: "0.4.0", paired: true, deviceName: "Test browser",
    canvasOrigin: null, hasCanvasAccess: false, signin: null,
  });
});

test("permission denied is reported and can be retried in place", { concurrency: false }, async () => {
  const state = harness({ access: false });
  await state.load();
  await state.send(START);
  const tab = state.created.at(-1);
  const page = await state.send({ type: "signin-page", sessionId: SESSION_ID }, state.page("signin", tab.id));
  assert.equal(page.status.stage, "needs-access");
  assert.equal(page.hasAccess, false);
  assert.equal(page.schoolName, "School University");
  assert.deepEqual(await state.send({ type: "signin-denied", sessionId: SESSION_ID }, state.page("signin", tab.id)), { ok: true });
  const denied = await state.status();
  assert.deepEqual([denied.stage, denied.reason], ["failed", "permission-denied"]);
  assert.deepEqual(await state.send({ type: "signin-continue", sessionId: SESSION_ID }, state.page("signin", tab.id)), { ok: false, reason: "permission-denied" });
  assert.ok(!state.log.includes(`tabs.update:${tab.id}:${LOGIN}`), "never navigates without access");
  assert.equal(state.probes, 0);

  state.permission = true;
  assert.deepEqual(await state.send({ type: "signin-continue", sessionId: SESSION_ID }, state.page("sidepanel")), { ok: true });
  assert.ok(state.log.includes(`tabs.update:${tab.id}:${LOGIN}`));
  const status = await state.status();
  assert.equal(status.stage, "signing-in");
  assert.equal("reason" in status, false);
});

test("a dashboard load in the sign-in tab is detected; cookies are read, the tab closes, then the jar is uploaded", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  const tab = await startAndContinue(state);
  assert.equal(state.probes, 0);

  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/login/ldap`, type: "main_frame", statusCode: 200 });
  await state.request("completed", { tabId: 555, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  await state.request("completed", { tabId: tab.id, url: "https://idp.school.edu/", type: "main_frame", statusCode: 200 });
  assert.equal(state.probes, 0, "login pages, other tabs and other hosts never trigger a probe");

  state.signedIn = true;
  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/?login_success=1`, type: "main_frame", statusCode: 200 });
  const status = await state.status();
  assert.equal(status.stage, "captured");
  assert.deepEqual(status.account, { id: "42", name: "Ada Student" });
  assert.equal(state.probes, 1);
  assert.ok(state.index("cookies.getAll") < state.index(`tabs.remove:${tab.id}`), "cookies are read before the tab closes");
  assert.ok(state.index(`tabs.remove:${tab.id}`) < state.index("upload"), "the tab closes before the upload");
  assert.ok(state.log.includes(`tabs.update:${GROVE_TAB}:active`), "focus returns to Grove");
  assert.deepEqual(state.stages(), ["opening", "signing-in", "verifying", "captured"], "closing the tab ourselves is not tab-closed");

  const [request] = state.groveRequests;
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.init.credentials, "omit");
  const body = JSON.parse(request.init.body);
  assert.deepEqual([body.sessionId, body.canvasOrigin], [SESSION_ID, ORIGIN]);
  assert.deepEqual(body.cookies.map((cookie) => cookie.name), ["canvas_session", "_csrf_token"]);
  assert.ok(body.cookies.every((cookie) => cookie.domain === "school.instructure.com" && !("storeId" in cookie)));
  assert.equal(state.local.get("connection").canvasOrigin, ORIGIN);

  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  await state.tick();
  assert.equal(state.groveRequests.length, 1, "a finished attempt never uploads a second jar");
});

test("Set-Cookie, Canvas API calls and tab URL changes each trigger an identity probe", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  const tab = await startAndContinue(state);

  await state.request("headers", { tabId: tab.id, url: `${ORIGIN}/login/saml`, type: "main_frame", statusCode: 302, responseHeaders: [{ name: "Set-Cookie", value: "log_session_id=abc; path=/; secure" }] });
  assert.equal(state.probes, 1);
  assert.equal((await state.status()).stage, "signing-in", "a signed-out probe keeps waiting");

  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/api/v1/users/self/favorites/courses`, type: "xmlhttprequest", statusCode: 200 });
  assert.equal(state.probes, 2);

  state.signedIn = true;
  state.ev.onUpdated.fire(tab.id, { status: "complete" }, { id: tab.id, url: `${ORIGIN}/courses` });
  await settle();
  assert.equal((await state.status()).stage, "captured");
  assert.equal(state.groveRequests.length, 1);
});

test("the identity probe accepts Canvas's while(1); JSON prefix", { concurrency: false }, async () => {
  const state = harness({ selfPrefix: "while(1);", signedIn: true });
  await state.load();
  const tab = await startAndContinue(state);
  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  assert.equal((await state.status()).stage, "captured");
});

test("Grove rejecting the jar is reported with the server code; the tab is already closed", { concurrency: false }, async () => {
  const state = harness({ signedIn: true, captureStatus: 401, captureBody: { code: "CANVAS_SESSION_INVALID" } });
  await state.load();
  const tab = await startAndContinue(state);
  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  const status = await state.status();
  assert.equal(status.stage, "failed");
  assert.equal(status.reason, "capture-rejected:CANVAS_SESSION_INVALID");
  assert.ok(state.index(`tabs.remove:${tab.id}`) < state.index("upload"));
  assert.ok(!state.stages().includes("tab-closed"));
});

test("a missing session cookie keeps the tab open and can be retried from the side panel", { concurrency: false }, async () => {
  const state = harness({ signedIn: true, jar: [{ name: "_csrf_token", value: "csrf", domain: "school.instructure.com", path: "/", session: true }] });
  await state.load();
  const tab = await startAndContinue(state);
  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  assert.equal((await state.status()).reason, "session-cookie-missing");
  assert.equal(state.index(`tabs.remove:${tab.id}`), -1);
  assert.equal(state.groveRequests.length, 0);
  assert.deepEqual(await state.send({ type: "signin-continue", sessionId: SESSION_ID }, state.page("sidepanel")), { ok: true });
  assert.equal((await state.status()).stage, "signing-in");
});

test("closing the sign-in tab is reported; signin-focus reopens Canvas directly once access is granted", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  const tab = await startAndContinue(state);
  await chrome.tabs.remove(tab.id); // the user closes it
  await settle();
  assert.equal((await state.status()).stage, "tab-closed");

  assert.deepEqual(await state.send({ type: "signin-focus", sessionId: SESSION_ID }), { ok: true });
  const reopened = state.created.at(-1);
  assert.equal(reopened.url, LOGIN, "no interstitial when access is already granted");
  assert.deepEqual([reopened.index, reopened.openerTabId], [4, GROVE_TAB]);
  assert.deepEqual(state.panels.at(-1), { tabId: reopened.id, path: `sidepanel.html?s=${SESSION_ID}`, enabled: true });
  assert.equal((await state.status()).stage, "signing-in");

  assert.deepEqual(await state.send({ type: "signin-focus", sessionId: SESSION_ID }), { ok: true });
  assert.ok(state.log.includes(`tabs.update:${reopened.id}:active`));
  assert.ok(state.log.includes("windows.update:1"));
  assert.equal(state.created.length, 2, "an open tab is focused, not duplicated");
});

test("an attempt older than 30 minutes expires, closes its tab and never reads cookies", { concurrency: false }, async () => {
  const state = harness({ signedIn: true });
  await state.load();
  const tab = await startAndContinue(state);
  state.offset = 31 * 60 * 1000;
  const status = await state.status();
  assert.deepEqual([status.stage, status.reason], ["failed", "expired"]);
  assert.ok(state.log.includes(`tabs.remove:${tab.id}`));
  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  assert.equal(state.probes, 0);
  assert.equal(state.index("cookies.getAll"), -1);
  assert.deepEqual(await state.send({ type: "signin-focus", sessionId: SESSION_ID }), { ok: false, reason: "expired" });
});

test("after a service-worker restart the attempt resumes from storage.session and the poll finishes it", { concurrency: false }, async () => {
  const first = harness();
  await first.load();
  const tab = await startAndContinue(first);

  // New worker: module state is gone, storage.session and the tab survive, no webRequest event arrives.
  const second = harness({ session: first.session, local: first.local, tabs: first.tabs });
  await second.load();
  assert.equal(second.probes, 1, "the restarted worker probes at once");
  assert.equal((await second.status()).stage, "signing-in");

  second.signedIn = true;
  second.offset = 2500;
  await second.tick();
  assert.equal((await second.status()).stage, "captured");
  assert.equal(second.groveRequests.length, 1);
  assert.ok(second.log.includes(`tabs.remove:${tab.id}`));
});

test("signin-cancel closes the tab and stops detection", { concurrency: false }, async () => {
  const state = harness({ signedIn: true });
  await state.load();
  const tab = await startAndContinue(state);
  assert.deepEqual(await state.send({ type: "signin-cancel", sessionId: SESSION_ID }), { ok: true });
  await settle();
  assert.ok(state.log.includes(`tabs.remove:${tab.id}`));
  assert.equal((await state.status()).stage, "cancelled");
  assert.ok(!state.stages().includes("tab-closed"));
  await state.request("completed", { tabId: tab.id, url: `${ORIGIN}/`, type: "main_frame", statusCode: 200 });
  assert.equal(state.probes, 0);
});

test("a new signin-start replaces the previous attempt and closes its tab", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  await state.send(START);
  const first = state.created.at(-1);
  assert.deepEqual(await state.send({ ...START, sessionId: OTHER_SESSION }), { ok: true });
  await settle();
  assert.ok(state.log.includes(`tabs.remove:${first.id}`));
  assert.equal(await state.status(SESSION_ID), null);
  assert.equal((await state.status(OTHER_SESSION)).stage, "opening");
  assert.ok(state.stages(SESSION_ID).includes("cancelled"));
  assert.ok(!state.stages(SESSION_ID).includes("tab-closed"));
});

test("signin-start requires pairing and validates the Canvas origin and session id", { concurrency: false }, async () => {
  const unpaired = harness({ paired: false });
  await unpaired.load();
  assert.deepEqual(await unpaired.send(START), { ok: false, reason: "not-paired" });

  const state = harness();
  await state.load();
  assert.deepEqual(await state.send({ ...START, canvasOrigin: "http://school.instructure.com", loginUrl: "http://school.instructure.com/login" }), { ok: false, reason: "invalid-origin" });
  assert.deepEqual(await state.send({ ...START, loginUrl: "https://evil.example/login" }), { ok: false, reason: "invalid-origin" });
  assert.deepEqual(await state.send({ ...START, sessionId: "nope" }), { ok: false, reason: "invalid-session" });
  assert.equal(state.created.length, 0);
});

test("pairing is accepted only from /welcome and /extension/connect", { concurrency: false }, async () => {
  const state = harness({ paired: false });
  await state.load();
  const pair = { type: "pair", token: TOKEN, deviceName: "Laptop" };
  assert.deepEqual(await state.send(pair, state.grove("/settings")), { ok: false, reason: "not-allowed" });
  assert.equal(state.local.has("connection"), false);
  assert.deepEqual(await state.send(pair, state.grove("/welcome")), { ok: true });
  assert.deepEqual(await state.send(pair, state.grove("/extension/connect")), { ok: true });
  assert.equal(state.local.get("connection").deviceName, "Laptop");
});

test("messages from other sites, frames or extension pages are refused", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  assert.equal(await state.send({ type: "hello" }, { id: EXT_ID, tab: { id: 3 }, frameId: 0, url: "https://evil.example/" }), undefined);
  assert.equal(await state.send({ type: "hello" }, { ...state.grove(), frameId: 2 }), undefined);
  assert.deepEqual(await state.send({ type: "signin-continue", sessionId: SESSION_ID }, { id: EXT_ID, url: `${EXT}popup.html` }), { ok: false, reason: "not-allowed" });
  assert.deepEqual(await state.send({ type: "signin-continue", sessionId: SESSION_ID }), { ok: false, reason: "not-allowed" }, "a web page cannot skip the interstitial's click");
});

test("install injects the content script into Grove tabs that were already open", { concurrency: false }, async () => {
  const state = harness();
  await state.load();
  state.ev.onInstalled.fire({ reason: "install" });
  await settle();
  assert.deepEqual(state.injected, [{ target: { tabId: GROVE_TAB }, files: ["content.js"] }]);
  assert.deepEqual(state.panels, [{ enabled: false }], "the side panel is never enabled globally");
});
