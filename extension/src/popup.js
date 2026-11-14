import { GROVE_ORIGIN } from "./config.js";

const $ = (id) => document.getElementById(id);
const views = [...document.querySelectorAll("[data-view]")];
const show = (name) => views.forEach((view) => { view.hidden = view.dataset.view !== name; });
const ask = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (reply) => resolve(chrome.runtime.lastError ? null : reply)));
const openTab = async (url) => { await chrome.tabs.create({ url }); window.close(); };

function chip(element, text, tone) { element.textContent = text; element.className = `chip ${tone}`; }

function render(state) {
  const top = $("top-chip");
  top.hidden = true;
  if (!state || state.state === "disconnected") return show("disconnected");
  if (state.state === "revoked") {
    $("revoked-text").textContent = state.deviceName
      ? `“${state.deviceName}” was disconnected from Canvas Grove. Connect it again to authenticate Canvas from this browser.`
      : "This browser was disconnected from Canvas Grove. Connect it again to authenticate Canvas from this browser.";
    return show("revoked");
  }
  if (state.state === "offline") return show("offline");

  $("device").textContent = state.deviceName ?? "This browser";
  const host = state.canvasOrigin ? new URL(state.canvasOrigin).host : null;
  $("host").textContent = host ?? "Not set up yet";
  chip(top, state.groveCanvas === "connected" ? "Connected" : "Needs attention", state.groveCanvas === "connected" ? "success" : "warning");
  top.hidden = false;
  chip($("chip-browser"), state.needsAccess ? "No access" : state.browserSignedIn ? "Yes" : "Not yet", state.browserSignedIn ? "success" : "info");
  chip($("chip-grove"), state.groveCanvas === "connected" ? "Signed in" : "Sign in needed", state.groveCanvas === "connected" ? "success" : "warning");

  const note = $("note");
  note.hidden = true;
  note.className = "note";
  if (!state.canvasOrigin) { note.textContent = "Open Canvas Grove to choose your Canvas site and begin sign-in."; note.hidden = false; }
  else if (state.needsAccess) { note.textContent = `Allow access only to ${host} so Grove can verify the Canvas account you confirm.`; note.className = "note info"; note.hidden = false; }
  else if (state.lastIssue && !state.browserSignedIn) { note.textContent = "Canvas did not accept the session in this browser. Open Grove and start Canvas sign-in again."; note.hidden = false; }
  else if (state.groveCanvas !== "connected") { note.textContent = "Canvas Grove needs a current Canvas session. Open Grove to sign in and confirm the account."; note.hidden = false; }

  $("open-canvas").hidden = !!state.needsAccess || !state.canvasOrigin;
  $("grant").hidden = !state.needsAccess;
  $("grant").textContent = "Allow access to Canvas";
  $("grant").dataset.origin = state.canvasOrigin ?? "";
  $("open-canvas").dataset.origin = state.canvasOrigin ?? "";
  show("connected");
}

async function refresh() { show("loading"); render(await ask({ type: "popup-state" })); }

const connect = () => openTab(`${GROVE_ORIGIN}/extension/connect`);
$("connect").addEventListener("click", connect);
$("reconnect").addEventListener("click", connect);
$("retry").addEventListener("click", refresh);
$("open-grove").addEventListener("click", () => openTab(GROVE_ORIGIN));
$("open-canvas").addEventListener("click", async (event) => {
  const origin = event.currentTarget.dataset.origin;
  if (!origin) return;
  event.currentTarget.disabled = true;
  await ask({ type: "open", url: `${origin}/` });
  window.close();
});
$("grant").addEventListener("click", async (event) => {
  const origin = event.currentTarget.dataset.origin;
  if (origin && (await chrome.permissions.request({ origins: [`${origin}/*`] }))) refresh();
});

let armed = null;
$("disconnect").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!armed) {
    button.textContent = "Click again to disconnect";
    armed = setTimeout(() => { armed = null; button.textContent = "Disconnect this browser"; }, 4000);
    return;
  }
  clearTimeout(armed); armed = null;
  button.disabled = true;
  await ask({ type: "disconnect" });
  button.disabled = false; button.textContent = "Disconnect this browser";
  render({ state: "disconnected" });
});

refresh();
