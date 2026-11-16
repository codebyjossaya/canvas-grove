import { GROVE_ORIGIN, GROVE_PATTERN } from "./config.js";
import { hasLiveSession, sameOrigin, toChromeCookie, toServerCookie } from "./cookies.js";
import { isAuthPath, signInSignal } from "./detect.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID = new RegExp(`^${UUID}$`);
const TOKEN = new RegExp(`^gfe1\\.${UUID}\\.${UUID}\\.[A-Za-z0-9_-]{43}$`);
const PROTOCOL = 2;
const SIGNIN_TTL_MS = 30 * 60 * 1000;
const POLL_MS = 2000;
const SIGNIN_KEY = "signin";
/** Stages in which the attempt is still waiting on the user. */
const ACTIVE = new Set(["opening", "needs-access", "signing-in"]);
/** Failures the user can retry in place (the same tab, the same attempt). */
const RETRYABLE = new Set(["permission-denied", "session-cookie-missing"]);
/** Grove pages allowed to hand the extension a device token. */
const PAIR_PATHS = ["/welcome", "/extension/connect"];

const quiet = async (work) => { try { return await work(); } catch { return undefined; } };

// ---- Grove connection (chrome.storage.local) -------------------------------------------------
// connection = { token | null, deviceName, canvasOrigin | null, revoked? }
const loadConnection = async () => (await chrome.storage.local.get("connection")).connection ?? null;
const saveConnection = (connection) => chrome.storage.local.set({ connection });

const hostPattern = (origin) => `${origin}/*`;
const hasAccess = async (origin) => !!origin && !!(await quiet(() => chrome.permissions.contains({ origins: [hostPattern(origin)] })));

/** Authenticated call to Grove. A 401 DEVICE_INVALID means the browser was disconnected from the website. */
async function groveFetch(connection, path, init = {}) {
  const response = await fetch(`${GROVE_ORIGIN}${path}`, {
    ...init,
    credentials: "omit",
    cache: "no-store",
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${connection.token}` },
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401 && body?.code === "DEVICE_INVALID") {
    await saveConnection({ ...connection, token: null, revoked: true });
    return { response, body, revoked: true };
  }
  return { response, body, revoked: false };
}

/**
 * Is this browser actually signed in to Canvas? A cookie named canvas_session proves nothing:
 * Canvas sets it for signed-out visitors too. Ask Canvas, as the browser, who the user is.
 */
async function browserIdentity(canvasOrigin) {
  if (!(await hasAccess(canvasOrigin))) return null;
  try {
    const response = await fetch(`${canvasOrigin}/api/v1/users/self`, { credentials: "include", cache: "no-store", redirect: "manual", headers: { accept: "application/json" } });
    if (response.status !== 200) return null;
    // Canvas prefixes cookie-authenticated JSON with `while(1);`, which response.json() rejects.
    const text = await response.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text.replace(/^while\(1\);/, "")); } catch { /* not JSON: treated as signed out */ }
    const id = typeof body?.id === "number" || typeof body?.id === "string" ? String(body.id) : "";
    if (!/^[0-9]{1,30}$/.test(id)) return null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    return { id, name: name || "Canvas user" };
  } catch { return null; }
}
const browserSignedIn = async (canvasOrigin) => Boolean(await browserIdentity(canvasOrigin));

/** Remember the last attempt so the popup and toolbar badge can say when Canvas refused the session. */
async function recordResult(session) {
  await chrome.storage.local.set({ lastResult: { ok: session.ok, reason: session.reason, at: Date.now() } });
  await quiet(async () => {
    if (session.ok) { await chrome.action.setBadgeText({ text: "" }); }
    else { await chrome.action.setBadgeBackgroundColor({ color: "#b02a1f" }); await chrome.action.setBadgeText({ text: "!" }); }
  });
}

async function installCookies(canvasOrigin, cookies) {
  let installed = 0;
  for (const cookie of cookies) {
    const details = toChromeCookie(cookie, canvasOrigin);
    if (!details) continue;
    try { if (await chrome.cookies.set(details)) installed += 1; } catch { /* a cookie the browser rejects is skipped */ }
  }
  return installed;
}

/** Make sure the browser has a Canvas session, fetching Grove's copy if needed. Never throws. */
async function ensureCanvasSession(connection, force) {
  const origin = connection.canvasOrigin;
  if (!origin || !connection.token || !(await hasAccess(origin))) return { ok: false, reason: "no-access" };
  if (!force && (await browserSignedIn(origin))) return { ok: true, reason: "already" };
  const { response, body, revoked } = await groveFetch(connection, "/api/extension/canvas-session", { method: "POST" });
  if (revoked) return { ok: false, reason: "revoked" };
  if (!response.ok || !body || body.canvasOrigin !== origin || !Array.isArray(body.cookies)) return { ok: false, reason: body?.code ?? "unavailable" };
  const installed = await installCookies(origin, body.cookies);
  // Verify: the cookies only count if Canvas now recognises this browser.
  const ok = installed > 0 && (await browserSignedIn(origin));
  return { ok, reason: ok ? "installed" : installed > 0 ? "rejected" : "not-installed" };
}

async function openCanvas(url, force) {
  const connection = await loadConnection();
  if (!connection?.token || !connection.canvasOrigin || !sameOrigin(url, connection.canvasOrigin)) return { ok: false, reason: "not-connected" };
  const session = await ensureCanvasSession(connection, force);
  await recordResult(session);
  await chrome.tabs.create({ url });
  return { ok: true, session: session.reason };
}

// ---- Sign-in attempt ---------------------------------------------------------------------------
// One attempt at a time, kept in chrome.storage.session so it survives service-worker restarts
// (not browser restarts). rec = { sessionId, canvasOrigin, loginUrl, schoolName, tabId, windowId,
// groveTabId, stage, account, reason, startedAt, at }.
const loadSignin = async () => (await chrome.storage.session.get(SIGNIN_KEY))[SIGNIN_KEY] ?? null;

let queue = Promise.resolve();
/** Serialises read-modify-write of the attempt so two detection events cannot both win. */
function exclusive(work) {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

function publicStatus(rec) {
  const status = { sessionId: rec.sessionId, stage: rec.stage, canvasOrigin: rec.canvasOrigin, at: rec.at };
  if (rec.account) status.account = { id: rec.account.id, name: rec.account.name };
  if (rec.reason) status.reason = rec.reason;
  return status;
}

const inStage = (...stages) => (rec) => stages.includes(rec.stage);
const retryable = (rec) => ACTIVE.has(rec.stage) || rec.stage === "tab-closed" || (rec.stage === "failed" && RETRYABLE.has(rec.reason));

/** Moves the attempt `sessionId` forward if `allowed(rec)`; announces the change. Returns the new record or null. */
async function transition(sessionId, allowed, patch) {
  const next = await exclusive(async () => {
    const rec = await loadSignin();
    if (!rec || rec.sessionId !== sessionId || (allowed && !allowed(rec))) return null;
    const updated = { ...rec, ...patch, at: Date.now() };
    await chrome.storage.session.set({ [SIGNIN_KEY]: updated });
    return updated;
  });
  if (next) await announce(next);
  return next;
}

/** The attempt, after applying the 30-minute TTL. */
async function current() {
  const rec = await loadSignin();
  if (rec && retryable(rec) && !(Date.now() - rec.startedAt <= SIGNIN_TTL_MS)) {
    const expired = await transition(rec.sessionId, retryable, { stage: "failed", reason: "expired", tabId: null });
    if (rec.tabId != null) await closeTab(rec.tabId);
    return expired ?? (await loadSignin());
  }
  return rec;
}

async function broadcast(events) {
  const tabs = (await quiet(() => chrome.tabs.query({ url: GROVE_PATTERN }))) ?? [];
  await Promise.all(tabs.map((tab) => quiet(() => chrome.tabs.sendMessage(tab.id, { type: "grove-events", events }))));
}

async function announce(rec) {
  const status = publicStatus(rec);
  // Extension pages (interstitial, side panel, popup) listen on the runtime channel.
  await quiet(() => chrome.runtime.sendMessage({ type: "signin-event", status }));
  await broadcast([{ type: "signin", status }, { type: "state", state: await extState(rec) }]);
}
const announceState = async () => broadcast([{ type: "state", state: await extState() }]);

async function extState(known) {
  const connection = await loadConnection();
  const rec = known ?? (await loadSignin());
  const canvasOrigin = connection?.canvasOrigin ?? rec?.canvasOrigin ?? null;
  return {
    installed: true,
    protocol: PROTOCOL,
    version: chrome.runtime.getManifest().version,
    paired: !!connection?.token && !connection.revoked,
    deviceName: connection?.deviceName ?? null,
    canvasOrigin,
    hasCanvasAccess: await hasAccess(canvasOrigin),
    signin: rec ? publicStatus(rec) : null,
  };
}

const closeTab = (tabId) => quiet(() => chrome.tabs.remove(tabId));
const enablePanel = (tabId, sessionId) => quiet(() => chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?s=${sessionId}`, enabled: true }));

/** New-tab placement right after the Grove tab that asked. */
function besideTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) return {};
  const placement = { openerTabId: tab.id };
  if (Number.isInteger(tab.index)) placement.index = tab.index + 1;
  if (Number.isInteger(tab.windowId)) placement.windowId = tab.windowId;
  return placement;
}

async function signinStart(sender, message) {
  const connection = await loadConnection();
  if (!connection?.token || connection.revoked) return { ok: false, reason: "not-paired" };
  let canvasOrigin;
  let loginUrl;
  try {
    canvasOrigin = new URL(String(message.canvasOrigin ?? "")).origin;
    loginUrl = new URL(String(message.loginUrl || `${canvasOrigin}/login`));
  } catch { return { ok: false, reason: "invalid-origin" }; }
  if (!canvasOrigin.startsWith("https://") || loginUrl.origin !== canvasOrigin) return { ok: false, reason: "invalid-origin" };
  const sessionId = String(message.sessionId ?? "");
  if (!SESSION_ID.test(sessionId)) return { ok: false, reason: "invalid-session" };
  const schoolName = typeof message.schoolName === "string" ? message.schoolName.replace(/\s+/g, " ").trim().slice(0, 80) : "";

  let tab;
  try {
    tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`signin.html?s=${sessionId}`), active: true, ...besideTab(sender.tab) });
  } catch { return { ok: false, reason: "tab-failed" }; }
  const now = Date.now();
  const rec = {
    sessionId, canvasOrigin, loginUrl: loginUrl.toString(), schoolName: schoolName || new URL(canvasOrigin).host,
    tabId: tab.id, windowId: tab.windowId ?? sender.tab?.windowId ?? null, groveTabId: sender.tab?.id ?? null,
    stage: "opening", account: null, reason: null, startedAt: now, at: now,
  };
  const previous = await exclusive(async () => {
    const prev = await loadSignin();
    await chrome.storage.session.set({ [SIGNIN_KEY]: rec });
    return prev;
  });
  // The panel must be configured before the interstitial's click can open it.
  await enablePanel(tab.id, sessionId);
  if (previous?.tabId != null && previous.tabId !== tab.id) await closeTab(previous.tabId);
  if (previous && previous.sessionId !== sessionId && retryable(previous)) {
    const replaced = publicStatus({ ...previous, stage: "cancelled", reason: "replaced", at: now });
    await quiet(() => chrome.runtime.sendMessage({ type: "signin-event", status: replaced }));
    await broadcast([{ type: "signin", status: replaced }]);
  }
  await announce(rec);
  startPolling();
  return { ok: true };
}

async function signinStatus(message) {
  const rec = await current();
  return rec && rec.sessionId === message.sessionId ? publicStatus(rec) : null;
}

async function signinFocus(sender, message) {
  const rec = await current();
  if (!rec || rec.sessionId !== message.sessionId) return { ok: false, reason: "unknown-session" };
  if (rec.tabId != null && (await quiet(() => chrome.tabs.get(rec.tabId)))) {
    await quiet(() => chrome.tabs.update(rec.tabId, { active: true }));
    if (rec.windowId != null) await quiet(() => chrome.windows.update(rec.windowId, { focused: true }));
    return { ok: true };
  }
  if (!retryable(rec)) return { ok: false, reason: rec.reason ?? rec.stage };
  // The user closed the tab. With access already granted there is nothing to confirm, so reopen
  // Canvas directly; otherwise reopen the interstitial, whose click grants access.
  const granted = await hasAccess(rec.canvasOrigin);
  let tab;
  try {
    tab = await chrome.tabs.create({ url: granted ? rec.loginUrl : chrome.runtime.getURL(`signin.html?s=${rec.sessionId}`), active: true, ...besideTab(sender.tab) });
  } catch { return { ok: false, reason: "tab-failed" }; }
  await enablePanel(tab.id, rec.sessionId);
  await transition(rec.sessionId, retryable, { tabId: tab.id, windowId: tab.windowId ?? rec.windowId, stage: granted ? "signing-in" : "opening", reason: null });
  startPolling();
  return { ok: true };
}

async function signinCancel(message) {
  const before = await loadSignin();
  if (!before || before.sessionId !== message.sessionId) return { ok: false, reason: "unknown-session" };
  if (before.stage === "cancelled") return { ok: true };
  // Cancelling first means the tab's onRemoved no longer matches an open attempt.
  const rec = await transition(before.sessionId, (r) => !["captured", "cancelled", "verifying"].includes(r.stage), { stage: "cancelled", reason: null, tabId: null });
  if (!rec) return { ok: false, reason: before.stage };
  if (before.tabId != null) await closeTab(before.tabId);
  return { ok: true };
}

/** Interstitial and side panel: everything they need to render, plus a fallback probe. */
async function signinPage(message, from) {
  let rec = await current();
  if (!rec || rec.sessionId !== message.sessionId) return { status: null };
  const access = await hasAccess(rec.canvasOrigin);
  if (from === "signin" && rec.stage === "opening" && !access) rec = (await transition(rec.sessionId, inStage("opening"), { stage: "needs-access" })) ?? rec;
  if (rec.stage === "signing-in") { startPolling(); if (Date.now() - lastProbe >= POLL_MS - 100) void kick(); }
  return { status: publicStatus(rec), schoolName: rec.schoolName, loginUrl: rec.loginUrl, hasAccess: access };
}

/** The interstitial's (or panel's) button: access is granted, take the tab to Canvas. */
async function signinContinue(message) {
  const rec = await current();
  if (!rec || rec.sessionId !== message.sessionId) return { ok: false, reason: "unknown-session" };
  if (!(await hasAccess(rec.canvasOrigin))) {
    await transition(rec.sessionId, retryable, { stage: "failed", reason: "permission-denied" });
    return { ok: false, reason: "permission-denied" };
  }
  if (rec.tabId == null) return { ok: false, reason: "tab-closed" };
  const next = await transition(rec.sessionId, retryable, { stage: "signing-in", reason: null });
  if (!next) return { ok: false, reason: rec.reason ?? rec.stage };
  if (!(await quiet(() => chrome.tabs.update(next.tabId, { url: next.loginUrl })))) {
    await transition(next.sessionId, inStage("signing-in"), { stage: "tab-closed", tabId: null });
    return { ok: false, reason: "tab-closed" };
  }
  startPolling();
  return { ok: true };
}

async function signinDenied(message) {
  await transition(String(message.sessionId ?? ""), retryable, { stage: "failed", reason: "permission-denied" });
  return { ok: true };
}

// ---- Detection ---------------------------------------------------------------------------------
let poller = null;
let probing = null;
let probeAgain = false;
let lastProbe = 0;

function startPolling() {
  if (poller) return;
  poller = setInterval(() => { void pollTick(); }, POLL_MS);
  poller?.unref?.();
}
function stopPolling() {
  if (poller) clearInterval(poller);
  poller = null;
}
/** Fallback in case webRequest events were missed (e.g. right after a service-worker restart). */
async function pollTick() {
  const rec = await current();
  if (!rec || !ACTIVE.has(rec.stage)) { stopPolling(); return; }
  if (rec.stage === "signing-in" && Date.now() - lastProbe >= POLL_MS - 100) await kick();
}

/** Ask Canvas who is signed in; one probe at a time, re-run once if more signals arrived meanwhile. */
function kick() {
  if (probing) { probeAgain = true; return probing; }
  probing = (async () => {
    try {
      do {
        probeAgain = false;
        const rec = await current();
        if (!rec || rec.stage !== "signing-in") return;
        lastProbe = Date.now();
        const account = await browserIdentity(rec.canvasOrigin);
        if (account) { await complete(rec.sessionId, account); return; }
      } while (probeAgain);
    } finally { probing = null; }
  })();
  return probing;
}

/** Canvas confirmed an account: read cookies, close the tab at once, then hand the jar to Grove. */
async function complete(sessionId, account) {
  const rec = await transition(sessionId, inStage("signing-in"), { stage: "verifying", account });
  if (!rec) return;
  const origin = rec.canvasOrigin;
  const fail = (reason, patch = {}) => transition(sessionId, inStage("verifying"), { stage: "failed", reason, ...patch });
  const raw = (await quiet(() => chrome.cookies.getAll({ url: `${origin}/` }))) ?? [];
  const cookies = raw.map((cookie) => toServerCookie(cookie, origin)).filter(Boolean);
  if (!hasLiveSession(raw) || !cookies.length) { await fail("session-cookie-missing"); return; }

  // Cookies outlive the tab, so close it now: the user is done with Canvas.
  if (rec.tabId != null) await closeTab(rec.tabId);
  if (rec.groveTabId != null) await quiet(() => chrome.tabs.update(rec.groveTabId, { active: true }));
  stopPolling();

  const connection = await loadConnection();
  if (!connection?.token) { await fail("not-paired", { tabId: null }); return; }
  let result;
  try {
    result = await groveFetch(connection, "/api/extension/canvas-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, canvasOrigin: origin, cookies }),
    });
  } catch { await fail("network", { tabId: null }); return; }
  const { response, body, revoked } = result;
  if (revoked) { await fail("revoked", { tabId: null }); return; }
  if (!response.ok || !body?.connected) {
    await recordResult({ ok: false, reason: "capture-rejected" });
    await fail(`capture-rejected:${typeof body?.code === "string" ? body.code : response.status}`, { tabId: null });
    return;
  }
  await saveConnection({ ...connection, canvasOrigin: origin, revoked: false });
  await recordResult({ ok: true, reason: "captured" });
  await transition(sessionId, inStage("verifying"), { stage: "captured", tabId: null });
}

async function onRequest(details) {
  if (!Number.isInteger(details?.tabId) || details.tabId < 0) return;
  const rec = await loadSignin();
  if (!rec || rec.stage !== "signing-in" || rec.tabId !== details.tabId) return;
  if (signInSignal(details, rec.canvasOrigin)) { startPolling(); await kick(); }
}

// Registered synchronously at top level so Chrome can wake the worker for them. Events only fire
// for hosts the extension may access: Grove plus the one Canvas origin the user granted.
const webFilter = { urls: ["https://*/*"], types: ["main_frame", "sub_frame", "xmlhttprequest"] };
try {
  chrome.webRequest.onCompleted.addListener((details) => { void onRequest(details); }, webFilter);
  chrome.webRequest.onHeadersReceived.addListener((details) => { void onRequest(details); }, webFilter, ["responseHeaders", "extraHeaders"]);
} catch { /* webRequest unavailable: tab URL watch and the poll still work */ }

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change?.status !== "complete" && !change?.url) return;
  void (async () => {
    const rec = await loadSignin();
    if (!rec || rec.stage !== "signing-in" || rec.tabId !== tabId) return;
    let url;
    try { url = new URL(change.url ?? tab?.url); } catch { return; }
    if (url.origin === rec.canvasOrigin && !isAuthPath(url.pathname)) await kick();
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const rec = await loadSignin();
    if (!rec || rec.tabId !== tabId) return;
    // Tabs the extension closes itself are already past these stages (verifying, cancelled, failed).
    await transition(rec.sessionId, (r) => r.tabId === tabId && retryable(r), { stage: "tab-closed", tabId: null, reason: null });
  })();
});

// ---- Pairing, popup ----------------------------------------------------------------------------
async function popupState() {
  const connection = await loadConnection();
  const rec = await current();
  const signin = rec ? { ...publicStatus(rec), schoolName: rec.schoolName } : null;
  if (!connection) return { state: "disconnected", signin };
  if (connection.revoked || !connection.token) return { state: "revoked", deviceName: connection.deviceName, signin };
  const base = { state: "connected", deviceName: connection.deviceName, canvasOrigin: connection.canvasOrigin, signin };
  let status;
  try { status = await groveFetch(connection, "/api/extension/status"); } catch { return { ...base, state: "offline" }; }
  if (status.revoked) return { state: "revoked", deviceName: connection.deviceName, signin };
  if (!status.response.ok || !status.body) return { ...base, state: "offline" };
  const canvasOrigin = status.body.canvasOrigin ?? connection.canvasOrigin;
  if (canvasOrigin !== connection.canvasOrigin) await saveConnection({ ...connection, canvasOrigin });
  const needsAccess = !!canvasOrigin && !(await hasAccess(canvasOrigin));
  const last = (await chrome.storage.local.get("lastResult")).lastResult;
  return {
    ...base,
    deviceName: status.body.deviceName ?? connection.deviceName, canvasOrigin,
    groveCanvas: status.body.canvasConnected ? "connected" : "expired",
    needsAccess, browserSignedIn: canvasOrigin && !needsAccess ? await browserSignedIn(canvasOrigin) : false,
    lastIssue: last?.ok === false ? last.reason : null,
  };
}

async function disconnect() {
  const connection = await loadConnection();
  if (connection?.token) await quiet(() => groveFetch(connection, "/api/extension/disconnect", { method: "POST" }));
  await chrome.storage.local.remove("connection");
  return { ok: true };
}

async function pair(message) {
  const name = typeof message.deviceName === "string" ? message.deviceName.trim().slice(0, 60) : "";
  let canvasOrigin = null;
  if (message.canvasOrigin) { try { const url = new URL(message.canvasOrigin); if (url.protocol === "https:") canvasOrigin = url.origin; } catch { /* ignore */ } }
  if (!TOKEN.test(message.token ?? "") || !name) return { ok: false };
  await saveConnection({ token: message.token, deviceName: name, canvasOrigin });
  return { ok: true };
}

// ---- Messaging ---------------------------------------------------------------------------------
function extensionPage(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return null;
  for (const page of ["popup", "signin", "sidepanel"]) if (sender.url.startsWith(chrome.runtime.getURL(`${page}.html`))) return page;
  return null;
}

function groveSender(sender) {
  if (!sender.tab || sender.frameId !== 0 || typeof sender.url !== "string" || !sameOrigin(sender.url, GROVE_ORIGIN)) return null;
  return new URL(sender.url).pathname;
}

async function route(message, sender) {
  const type = message?.type;
  const page = extensionPage(sender);
  const grovePath = page ? null : groveSender(sender);
  if (grovePath !== null) {
    if (type === "hello") return extState();
    if (type === "pair") return PAIR_PATHS.some((path) => grovePath === path || grovePath.startsWith(`${path}/`)) ? pair(message) : { ok: false, reason: "not-allowed" };
    if (type === "signin-start") return signinStart(sender, message);
    if (type === "signin-status") return signinStatus(message);
    if (type === "signin-focus") return signinFocus(sender, message);
    if (type === "signin-cancel") return signinCancel(message);
    if (type === "open") return openCanvas(String(message.url ?? ""), !!message.force);
    return { ok: false, reason: "not-allowed" };
  }
  if (page === "popup") {
    if (type === "popup-state") return popupState();
    if (type === "disconnect") return disconnect();
    if (type === "open") return openCanvas(String(message.url ?? ""), !!message.force);
    if (type === "signin-focus") return signinFocus(sender, message);
  }
  if (page === "signin" || page === "sidepanel") {
    if (type === "signin-page") return signinPage(message, page);
    if (type === "signin-continue") return signinContinue(message);
    if (type === "signin-denied") return signinDenied(message);
    if (type === "signin-cancel") return signinCancel(message);
  }
  return { ok: false, reason: "not-allowed" };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!extensionPage(sender) && groveSender(sender) === null) return false;
  route(message, sender).then(respond, () => respond({ ok: false, reason: "error" }));
  return true;
});

/**
 * Content scripts are not injected into tabs that were open before install, so the orientation
 * page could not see the extension until a reload. Inject into open Grove tabs now.
 */
async function injectContentScripts() {
  const tabs = (await quiet(() => chrome.tabs.query({ url: GROVE_PATTERN }))) ?? [];
  await Promise.all(tabs.map((tab) => quiet(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }))));
}

chrome.runtime.onInstalled.addListener(() => {
  // The panel is tab-scoped: enabled only for a sign-in tab, never globally.
  void quiet(() => chrome.sidePanel.setOptions({ enabled: false }));
  void injectContentScripts();
});
chrome.runtime.onStartup.addListener(() => { void injectContentScripts(); });
chrome.permissions.onAdded.addListener(() => { void announceState(); });
chrome.permissions.onRemoved.addListener(() => { void announceState(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.connection) void announceState(); });

/** Service-worker (re)start: pick up an attempt that was in flight. */
async function resume() {
  let rec = await current();
  // A worker that died mid-upload never finished it; probe again (cookies outlive the tab).
  if (rec?.stage === "verifying") rec = await transition(rec.sessionId, inStage("verifying"), { stage: "signing-in" });
  if (rec && ACTIVE.has(rec.stage)) startPolling();
  if (rec?.stage === "signing-in") await kick();
}
void resume().catch(() => undefined);
