// Runs on Grove pages. Once this browser is connected, a click on a link to the user's Canvas site
// opens it in a new tab with the Canvas session installed first. Shift-click refreshes the
// browser's Canvas session from Grove. When not connected, links behave normally.
(() => {
  const WEB = "grove-web";
  const EXT = "grove-extension";
  let canvasOrigin = null;
  let busy = false;
  const apply = (connection) => { canvasOrigin = connection?.token && connection.canvasOrigin ? connection.canvasOrigin : null; };
  const say = (type, requestId, result) => window.postMessage({ source: EXT, type, requestId, result }, window.location.origin);

  try {
    chrome.storage.local.get("connection").then((stored) => apply(stored.connection));
    chrome.storage.onChanged.addListener((changes) => { if (changes.connection) apply(changes.connection.newValue); });
  } catch { return; }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== WEB) return;
    const requestId = typeof event.data.requestId === "string" ? event.data.requestId : "";
    if (!["canvas-auth-state", "canvas-auth-open", "canvas-auth-check", "canvas-auth-capture"].includes(event.data.type)) return;
    try {
      chrome.runtime.sendMessage({
        type: event.data.type,
        sessionId: event.data.sessionId,
        canvasOrigin: event.data.canvasOrigin,
        loginUrl: event.data.loginUrl,
      }, (result) => {
        const failed = chrome.runtime.lastError || !result;
        say("canvas-auth-result", requestId, failed ? { ok: false, reason: "unavailable" } : result);
      });
    } catch { say("canvas-auth-result", requestId, { ok: false, reason: "unavailable" }); }
  });

  function handle(event) {
    if (!canvasOrigin || event.defaultPrevented) return;
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
})();
