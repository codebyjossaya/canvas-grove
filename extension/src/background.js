import { GROVE_ORIGIN } from "./config.js";
import { SESSION_COOKIE_NAMES, hasLiveSession, sameOrigin, toChromeCookie } from "./cookies.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(`^gfe1\\.${UUID}\\.${UUID}\\.[A-Za-z0-9_-]{43}$`);

// connection = { token | null, deviceName, canvasOrigin | null, revoked? }
const loadConnection = async () => (await chrome.storage.local.get("connection")).connection ?? null;
const saveConnection = (connection) => chrome.storage.local.set({ connection });

const hostPattern = (origin) => `${origin}/*`;
const hasAccess = (origin) => chrome.permissions.contains({ origins: [hostPattern(origin)] });

/** Authenticated call to Grove. A 401 DEVICE_INVALID means the browser was disconnected from the website. */
async function groveFetch(connection, path, init = {}) {
  const response = await fetch(`${GROVE_ORIGIN}${path}`, { ...init, credentials: "omit", cache: "no-store", headers: { authorization: `Bearer ${connection.token}` } });
  const body = await response.json().catch(() => null);
  if (response.status === 401 && body?.code === "DEVICE_INVALID") {
    await saveConnection({ ...connection, token: null, revoked: true });
    return { response, body, revoked: true };
  }
  return { response, body, revoked: false };
}

async function browserHasSession(canvasOrigin) {
  if (!(await hasAccess(canvasOrigin))) return false;
  const cookies = (await Promise.all(SESSION_COOKIE_NAMES.map((name) => chrome.cookies.get({ url: canvasOrigin, name })))).filter(Boolean);
  return hasLiveSession(cookies);
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
  if (!force && (await browserHasSession(origin))) return { ok: true, reason: "already" };
  const { response, body, revoked } = await groveFetch(connection, "/api/extension/canvas-session", { method: "POST" });
  if (revoked) return { ok: false, reason: "revoked" };
  if (!response.ok || !body || body.canvasOrigin !== origin || !Array.isArray(body.cookies)) return { ok: false, reason: body?.code ?? "unavailable" };
  return { ok: (await installCookies(origin, body.cookies)) > 0, reason: "installed" };
}

async function openCanvas(url, force) {
  const connection = await loadConnection();
  if (!connection?.token || !connection.canvasOrigin || !sameOrigin(url, connection.canvasOrigin)) return { ok: false, reason: "not-connected" };
  const session = await ensureCanvasSession(connection, force);
  await chrome.tabs.create({ url });
  return { ok: true, session: session.reason };
}

async function popupState() {
  const connection = await loadConnection();
  if (!connection) return { state: "disconnected" };
  if (connection.revoked || !connection.token) return { state: "revoked", deviceName: connection.deviceName };
  const base = { state: "connected", deviceName: connection.deviceName, canvasOrigin: connection.canvasOrigin };
  let status;
  try { status = await groveFetch(connection, "/api/extension/status"); } catch { return { ...base, state: "offline" }; }
  if (status.revoked) return { state: "revoked", deviceName: connection.deviceName };
  if (!status.response.ok || !status.body) return { ...base, state: "offline" };
  const canvasOrigin = status.body.canvasOrigin ?? connection.canvasOrigin;
  if (canvasOrigin !== connection.canvasOrigin) await saveConnection({ ...connection, canvasOrigin });
  const needsAccess = !!canvasOrigin && !(await hasAccess(canvasOrigin));
  return {
    state: "connected", deviceName: status.body.deviceName ?? connection.deviceName, canvasOrigin,
    groveCanvas: status.body.canvasConnected ? "connected" : "expired",
    needsAccess, browserSignedIn: canvasOrigin && !needsAccess ? await browserHasSession(canvasOrigin) : false,
  };
}

async function disconnect() {
  const connection = await loadConnection();
  if (connection?.token) { try { await groveFetch(connection, "/api/extension/disconnect", { method: "POST" }); } catch { /* the website can still revoke it */ } }
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromPopup = sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL("popup.html"));
  const fromGrove = !!sender.tab && sender.frameId === 0 && typeof sender.url === "string" && sameOrigin(sender.url, GROVE_ORIGIN);
  const fromConnectPage = fromGrove && new URL(sender.url).pathname.startsWith("/extension/connect");
  (async () => {
    if (fromPopup && message?.type === "popup-state") return popupState();
    if (fromPopup && message?.type === "disconnect") return disconnect();
    if ((fromPopup || fromGrove) && message?.type === "open") return openCanvas(String(message.url ?? ""), !!message.force);
    if (fromConnectPage && message?.type === "pair") return pair(message);
    return { ok: false, reason: "not-allowed" };
  })().then(respond, () => respond({ ok: false, reason: "error" }));
  return true;
});
