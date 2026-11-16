// Sign-in interstitial. Its one button is the user gesture Chrome requires for both
// chrome.permissions.request and chrome.sidePanel.open; a message from a web page carries none.
import { $, ask, hostOf, onSigninEvent, reasonText, show } from "./ui.js";

const sessionId = new URLSearchParams(location.search).get("s") ?? "";
let page = null;
let tabId = null;
let busy = false;

function focusHeading(id) { $(id)?.focus({ preventScroll: true }); }

function ended(title, text) {
  $("ended-title").textContent = title;
  $("ended-text").textContent = text;
  show("ended");
  focusHeading("ended-title");
}

function render(next) {
  page = next;
  const status = page?.status;
  if (!status) return ended("This sign-in link has ended", "Start sign-in again from Grove.");
  const host = hostOf(status.canvasOrigin);
  if (status.stage === "cancelled") return ended("Sign-in cancelled", status.reason === "replaced" ? reasonText("replaced", host) : "Start sign-in again from Grove when you're ready.");
  if (status.stage === "captured") return ended("You're signed in", `Grove saved your Canvas session for ${host}. You can close this tab.`);
  if (status.stage === "failed" && status.reason !== "permission-denied") return ended("Sign-in didn't finish", reasonText(status.reason, host));

  const school = page.schoolName || host;
  const wasHidden = $("ready-title").closest("section").hidden;
  $("ready-title").textContent = `Sign in to ${school} Canvas`;
  document.title = `Sign in to ${school} Canvas · Grove`;
  for (const id of ["host", "host-2", "host-3"]) $(id).textContent = host;
  $("access-help").hidden = !!page.hasAccess;
  const denied = status.stage === "failed" && status.reason === "permission-denied";
  $("error").hidden = !denied;
  $("error").textContent = denied ? reasonText("permission-denied", host) : "";
  $("continue").textContent = denied ? `Allow access and continue` : `Continue to ${school} Canvas`;
  $("continue").disabled = busy;
  show("ready");
  if (wasHidden) focusHeading("ready-title");
}

async function refresh() { render(await ask({ type: "signin-page", sessionId })); }

$("continue").addEventListener("click", () => {
  if (busy || !page?.status) return;
  busy = true;
  $("continue").disabled = true;
  const origin = page.status.canvasOrigin;
  // Both calls start synchronously inside the click so they carry the user gesture.
  const panel = tabId != null ? chrome.sidePanel.open({ tabId }).then(() => true, () => false) : Promise.resolve(false);
  const granted = page.hasAccess ? Promise.resolve(true) : chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  void Promise.all([granted, panel]).then(async ([ok]) => {
    const reply = ok ? await ask({ type: "signin-continue", sessionId }) : (await ask({ type: "signin-denied", sessionId }), { ok: false });
    busy = false;
    // On success the tab is already navigating to Canvas; otherwise show the reason in place.
    if (!reply?.ok) await refresh();
  });
});

$("cancel").addEventListener("click", async () => {
  $("cancel").disabled = true;
  const reply = await ask({ type: "signin-cancel", sessionId });
  if (!reply?.ok) { $("cancel").disabled = false; await refresh(); }
});

$("close").addEventListener("click", () => {
  if (tabId != null) void chrome.tabs.remove(tabId).catch(() => window.close());
  else window.close();
});

onSigninEvent(sessionId, () => { if (!busy) void refresh(); });

(async () => {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  tabId = Number.isInteger(tab?.id) ? tab.id : null;
  await refresh();
})();
