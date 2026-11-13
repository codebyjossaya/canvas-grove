// Runs on Grove pages. Once this browser is connected, a click on a link to the user's Canvas site
// opens it in a new tab with the Canvas session installed first. Shift-click refreshes the
// browser's Canvas session from Grove. When not connected, links behave normally.
(() => {
  let canvasOrigin = null;
  let busy = false;
  const apply = (connection) => { canvasOrigin = connection?.token && connection.canvasOrigin ? connection.canvasOrigin : null; };

  try {
    chrome.storage.local.get("connection").then((stored) => apply(stored.connection));
    chrome.storage.onChanged.addListener((changes) => { if (changes.connection) apply(changes.connection.newValue); });
  } catch { return; }

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
