import { SESSION_COOKIE_NAMES, hasLiveSession, normalizeOrigin, sameOrigin, toChromeCookie } from "./cookies.js";

const SCRIPT_ID = "grove-canvas-links";

async function settings() {
  const { groveOrigin, canvasOrigin } = await chrome.storage.local.get(["groveOrigin", "canvasOrigin"]);
  return { groveOrigin: normalizeOrigin(groveOrigin), canvasOrigin: normalizeOrigin(canvasOrigin) };
}

/** Run content.js on the configured Grove origin only. */
async function registerContentScript() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch { /* not registered */ }
  const { groveOrigin } = await settings();
  if (!groveOrigin) return;
  if (!(await chrome.permissions.contains({ origins: [`${groveOrigin}/*`] }))) return;
  await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, matches: [`${groveOrigin}/*`], js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true }]);
}

chrome.runtime.onInstalled.addListener(registerContentScript);
chrome.runtime.onStartup.addListener(registerContentScript);
chrome.storage.onChanged.addListener(registerContentScript);
chrome.permissions.onAdded.addListener(registerContentScript);

async function browserHasSession(canvasOrigin) {
  const cookies = (await Promise.all(SESSION_COOKIE_NAMES.map((name) => chrome.cookies.get({ url: canvasOrigin, name })))).filter(Boolean);
  return hasLiveSession(cookies);
}

async function install(canvasOrigin, cookies) {
  let installed = 0;
  for (const cookie of cookies) {
    const details = toChromeCookie(cookie, canvasOrigin);
    if (!details) continue;
    try { if (await chrome.cookies.set(details)) installed += 1; } catch { /* skip a cookie the browser rejects */ }
  }
  return installed;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    const { groveOrigin, canvasOrigin } = await settings();
    // Only the configured Grove page may talk to us, and only about the configured Canvas origin.
    if (!groveOrigin || !canvasOrigin || !sender.url || !sameOrigin(sender.url, groveOrigin)) return respond({ ok: false, reason: "not-configured" });
    if (message?.type === "config") return respond({ ok: true, canvasOrigin });
    if (!sameOrigin(message?.url, canvasOrigin)) return respond({ ok: false, reason: "wrong-origin" });
    if (message.type === "check") return respond({ ok: true, needCookies: !!message.force || !(await browserHasSession(canvasOrigin)) });
    if (message.type === "open") {
      let installed = 0;
      if (message.payload) {
        if (message.payload.canvasOrigin !== canvasOrigin || !Array.isArray(message.payload.cookies)) return respond({ ok: false, reason: "bad-payload" });
        installed = await install(canvasOrigin, message.payload.cookies);
      }
      await chrome.tabs.create({ url: message.url, index: sender.tab ? sender.tab.index + 1 : undefined });
      return respond({ ok: true, installed });
    }
    respond({ ok: false, reason: "unknown" });
  })().catch(() => respond({ ok: false, reason: "error" }));
  return true;
});
