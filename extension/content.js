// Runs only on the configured Grove origin. Links to Canvas open in a new tab with the user's
// Canvas session installed first (Shift-click: replace the browser's session with Grove's).
(async () => {
  const ask = (message) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? null : r)); } catch { resolve(null); }
  });
  const config = await ask({ type: "config" });
  if (!config?.ok) return;
  const canvasOrigin = config.canvasOrigin;
  let busy = false;

  async function openCanvas(url, force) {
    if (busy) return;
    busy = true;
    try {
      const check = await ask({ type: "check", url, force });
      let payload;
      if (check?.needCookies) {
        try {
          const res = await fetch("/api/canvas/extension/session", { method: "POST", credentials: "same-origin", headers: { "x-grove-extension": "1" } });
          if (res.ok) payload = await res.json();
        } catch { /* fall through: open without cookies */ }
      }
      await ask({ type: "open", url, payload });
    } finally { busy = false; }
  }

  function handler(event) {
    if (event.defaultPrevented || (event.type === "auxclick" && event.button !== 1) || (event.type === "click" && event.button !== 0)) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    let url;
    try { url = new URL(link.href); } catch { return; }
    if (url.origin !== canvasOrigin) return;
    event.preventDefault();
    event.stopPropagation();
    void openCanvas(url.toString(), event.shiftKey);
  }
  document.addEventListener("click", handler, true);
  document.addEventListener("auxclick", handler, true);
})();
