// Runs on every Grove page (and is injected into Grove tabs that were open at install time).
// It is the only bridge between the website and the extension (protocol v2):
//   page -> extension: window.postMessage({ source: "grove-web", type, requestId, ...fields })
//   extension -> page: { source: "grove-extension", type: "reply", requestId, result }
//                      { source: "grove-extension", type: "state", state }    (unsolicited)
//                      { source: "grove-extension", type: "signin", status }  (unsolicited)
// It also opens links to the user's Canvas site through the extension, with the session installed.
(() => {
  const WEB = "grove-web";
  const EXT = "grove-extension";
  const REQUESTS = new Set(["hello", "pair", "signin-start", "signin-status", "signin-focus", "signin-cancel", "open"]);
  const FIELDS = ["token", "deviceName", "canvasOrigin", "sessionId", "loginUrl", "schoolName", "url", "force"];

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (window.__groveExtension?.alive?.()) return; // already running in this page
  window.__groveExtension = { alive };

  let canvasOrigin = null;
  let busy = false;
  const post = (message) => window.postMessage({ source: EXT, ...message }, window.location.origin);
  const ask = (message) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => resolve(chrome.runtime.lastError || reply === undefined ? null : reply));
    } catch { resolve(null); }
  });
  const apply = (connection) => { canvasOrigin = connection?.token && !connection.revoked && connection.canvasOrigin ? connection.canvasOrigin : null; };

  async function postState() {
    const state = await ask({ type: "hello" });
    if (state?.installed) post({ type: "state", state });
  }

  try {
    chrome.storage.local.get("connection").then((stored) => apply(stored.connection), () => undefined);
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.connection) apply(changes.connection.newValue); });
    // Events pushed by the background worker (sign-in stage changes, state changes).
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender?.id !== chrome.runtime.id || sender.tab || message?.type !== "grove-events" || !Array.isArray(message.events)) return;
      for (const event of message.events) {
        if (event?.type === "state" && event.state) post({ type: "state", state: event.state });
        if (event?.type === "signin" && event.status) post({ type: "signin", status: event.status });
      }
    });
  } catch { return; }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== WEB || typeof data.type !== "string") return;
    if (!alive()) return;
    const requestId = typeof data.requestId === "string" && data.requestId.length <= 100 ? data.requestId : "";

    // Protocol v1 handshake on /extension/connect (kept so an older page still pairs).
    if (!requestId && data.type === "ping") { post({ type: "present" }); return; }
    if (!requestId && data.type === "pair") {
      ask({ type: "pair", token: data.token, deviceName: data.deviceName, canvasOrigin: data.canvasOrigin })
        .then((result) => post({ type: result?.ok ? "paired" : "pair-failed" }));
      return;
    }

    if (!requestId || !REQUESTS.has(data.type)) return;
    const source = data.payload && typeof data.payload === "object" ? data.payload : data;
    const message = { type: data.type };
    for (const field of FIELDS) if (source[field] !== undefined) message[field] = source[field];
    ask(message).then((result) => post({ type: "reply", requestId, result: result ?? { ok: false, reason: "unavailable" } }));
  });

  function handle(event) {
    if (!canvasOrigin || event.defaultPrevented || !alive()) return;
    if ((event.type === "click" && event.button !== 0) || (event.type === "auxclick" && event.button !== 1)) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    let url;
    try { url = new URL(link.href); } catch { return; }
    if (url.origin !== canvasOrigin) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    busy = true;
    try { chrome.runtime.sendMessage({ type: "open", url: url.toString(), force: event.shiftKey }, () => { busy = false; void chrome.runtime.lastError; }); }
    catch { busy = false; window.open(url.toString(), "_blank", "noopener"); }
  }
  document.addEventListener("click", handle, true);
  document.addEventListener("auxclick", handle, true);

  void postState();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void postState(); }, { once: true });
})();
