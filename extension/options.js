import { normalizeOrigin } from "./cookies.js";

const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };

chrome.storage.local.get(["groveOrigin", "canvasOrigin"]).then((s) => {
  $("grove").value = s.groveOrigin ?? "";
  $("canvas").value = s.canvasOrigin ?? "";
});

$("save").addEventListener("click", async () => {
  const groveOrigin = normalizeOrigin($("grove").value);
  const canvasOrigin = normalizeOrigin($("canvas").value);
  if (!groveOrigin || !canvasOrigin) return status("Both addresses must be https:// (http://localhost is allowed for Grove).");
  const granted = await chrome.permissions.request({ origins: [`${groveOrigin}/*`, `${canvasOrigin}/*`] });
  if (!granted) return status("Access was not granted, so nothing changed.");
  await chrome.storage.local.set({ groveOrigin, canvasOrigin });
  status("Saved. Reload any open Grove tabs.");
});
