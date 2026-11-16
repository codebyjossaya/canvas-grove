import { GROVE_ORIGIN } from "./config.js";
import { $, ask, hostOf, show } from "./ui.js";

const openTab = async (url) => { await chrome.tabs.create({ url }); window.close(); };
const IN_PROGRESS = new Set(["opening", "needs-access", "signing-in", "verifying", "tab-closed"]);

function chip(element, text, tone) { element.textContent = text; element.className = `chip ${tone}`; }

function renderSignin(signin) {
  const host = hostOf(signin.canvasOrigin);
  const school = signin.schoolName || host;
  $("signin-title").textContent = signin.stage === "verifying" ? "Confirming your Canvas account" : `Sign in to ${school} Canvas`;
  $("signin-text").textContent = signin.stage === "tab-closed"
    ? `The sign-in tab for ${host} was closed. Reopen it to finish signing in.`
    : `Finish signing in to ${host} in the sign-in tab. It closes by itself once Canvas signs you in.`;
  $("signin-focus").textContent = signin.stage === "tab-closed" ? "Reopen sign-in tab" : "Go to sign-in tab";
  $("signin-focus").dataset.session = signin.sessionId;
  show("signin");
}

function render(state) {
  const top = $("top-chip");
  top.hidden = true;
  if (state?.signin && IN_PROGRESS.has(state.signin.stage) && state.state !== "revoked") return renderSignin(state.signin);
  if (!state || state.state === "disconnected") return show("disconnected");
  if (state.state === "revoked") {
    $("revoked-text").textContent = state.deviceName
      ? `“${state.deviceName}” was disconnected from Canvas Grove. Connect it again to sign in to Canvas from this browser.`
      : "This browser was disconnected from Canvas Grove. Connect it again to sign in to Canvas from this browser.";
    return show("revoked");
  }
  if (state.state === "offline") return show("offline");

  $("device").textContent = state.deviceName ?? "This browser";
  const host = state.canvasOrigin ? hostOf(state.canvasOrigin) : null;
  $("host").textContent = host ?? "Not set up yet";
  const connected = state.groveCanvas === "connected";
  chip(top, connected ? "Connected" : "Needs sign-in", connected ? "success" : "warning");
  top.hidden = false;
  chip($("chip-browser"), state.needsAccess ? "No access" : state.browserSignedIn ? "Signed in" : "Signed out", state.browserSignedIn ? "success" : "info");
  chip($("chip-grove"), connected ? "Signed in" : "Sign-in needed", connected ? "success" : "warning");

  const note = $("note");
  note.hidden = true;
  note.className = "note";
  if (!state.canvasOrigin) { note.textContent = "Open Canvas Grove to choose your school and sign in to Canvas."; note.hidden = false; }
  else if (state.needsAccess) { note.textContent = `Allow access to ${host} only, so Grove can confirm which Canvas account is signed in.`; note.className = "note info"; note.hidden = false; }
  else if (state.lastIssue && !state.browserSignedIn) { note.textContent = "Canvas didn't accept the saved session in this browser. Open Grove and sign in to Canvas again."; note.hidden = false; }
  else if (!connected) { note.textContent = "Grove needs a current Canvas session. Open Grove to sign in to Canvas again."; note.hidden = false; }

  $("open-canvas").hidden = !!state.needsAccess || !state.canvasOrigin;
  $("grant").hidden = !state.needsAccess;
  $("grant").textContent = host ? `Allow access to ${host}` : "Allow access to Canvas";
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
$("signin-grove").addEventListener("click", () => openTab(GROVE_ORIGIN));
$("signin-focus").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  await ask({ type: "signin-focus", sessionId: event.currentTarget.dataset.session });
  window.close();
});
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
