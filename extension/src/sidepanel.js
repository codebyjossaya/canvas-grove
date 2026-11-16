// Tab-scoped side panel shown beside the Canvas sign-in tab. It reflects the attempt's stage live
// (pushed events plus a 2 s refresh, which also keeps the background's fallback probe running).
import { $, ask, hostOf, onSigninEvent, reasonText, show } from "./ui.js";

const sessionId = new URLSearchParams(location.search).get("s") ?? "";
const REFRESH_MS = 2000;
let page = null;
let view = "loading";
let timer = null;

function enter(name, headingId) {
  const changed = view !== name;
  view = name;
  show(name);
  if (changed) $(headingId)?.focus({ preventScroll: true });
}

function ended(title, text) {
  $("ended-title").textContent = title;
  $("ended-text").textContent = text;
  enter("ended", "ended-title");
  if (timer) { clearInterval(timer); timer = null; }
}

function steps(current) {
  ["step-1", "step-2", "step-3"].forEach((id, index) => {
    $(id).className = index + 1 === current ? "current" : index + 1 < current ? "past" : "";
    if (index + 1 === current) $(id).setAttribute("aria-current", "step"); else $(id).removeAttribute("aria-current");
  });
}

function render(next) {
  page = next;
  const status = page?.status;
  if (!status) return ended("This sign-in has ended", "Start sign-in again from Grove.");
  const host = hostOf(status.canvasOrigin);
  const school = page.schoolName || host;
  const name = status.account?.name;
  if (status.stage === "captured") return ended(name ? `Signed in as ${name}` : "Signed in", `Grove saved your session for ${host}. You can go back to Grove.`);
  if (status.stage === "cancelled") return ended("Sign-in cancelled", status.reason === "replaced" ? reasonText("replaced", host) : "Start sign-in again from Grove when you're ready.");
  if (status.stage === "tab-closed") return ended("Sign-in tab closed", reasonText("tab-closed", host));
  const retryable = status.stage === "failed" && (status.reason === "permission-denied" || status.reason === "session-cookie-missing");
  if (status.stage === "failed" && !retryable) return ended("Sign-in didn't finish", reasonText(status.reason, host));

  $("host-fine").textContent = host;
  const watch = $("watch");
  watch.className = "watch";
  $("error").hidden = true;
  $("retry").hidden = true;
  $("cancel").disabled = false;

  if (status.stage === "opening" || status.stage === "needs-access") {
    $("title").textContent = `Sign in to ${school} Canvas`;
    $("body").textContent = `Choose “Continue to ${school} Canvas” on the page to open Canvas in this tab.`;
    $("status-title").textContent = "Waiting for you to continue";
    $("status-detail").textContent = status.stage === "needs-access" ? `Chrome will ask to allow access to ${host}.` : host;
    steps(0);
  } else if (status.stage === "signing-in") {
    $("title").textContent = `Sign in to ${school} Canvas in this tab`;
    $("body").textContent = "Use your usual school login. Two-factor prompts such as Duo appear on the page as normal.";
    $("status-title").textContent = "Waiting for Canvas to sign you in";
    $("status-detail").textContent = `Grove is watching ${host} for a completed sign-in.`;
    steps(1);
  } else if (status.stage === "verifying") {
    $("title").textContent = "Confirming your Canvas account";
    $("body").textContent = "Canvas signed you in. Grove is saving the session now.";
    $("status-title").textContent = name ? `Signed in as ${name}` : "Signed in to Canvas";
    $("status-detail").textContent = `on ${host}. This tab closes in a moment.`;
    watch.className = "watch done";
    $("cancel").disabled = true;
    steps(2);
  } else if (retryable) {
    $("title").textContent = "Sign-in didn't finish";
    $("body").textContent = `Nothing was saved. You can try again in this tab.`;
    $("status-title").textContent = "Stopped";
    $("status-detail").textContent = host;
    watch.className = "watch stopped";
    $("error").textContent = reasonText(status.reason, host);
    $("error").hidden = false;
    $("retry").textContent = status.reason === "permission-denied" ? `Allow access to ${host}` : "Sign in again";
    $("retry").hidden = false;
    steps(status.reason === "permission-denied" ? 0 : 1);
  }
  enter("active", "title");
}

async function refresh() { render(await ask({ type: "signin-page", sessionId })); }

$("retry").addEventListener("click", () => {
  const status = page?.status;
  if (!status) return;
  $("retry").disabled = true;
  // Called inside the click so the permission prompt has its user gesture.
  const granted = page.hasAccess ? Promise.resolve(true) : chrome.permissions.request({ origins: [`${status.canvasOrigin}/*`] }).catch(() => false);
  void granted.then(async (ok) => {
    if (ok) await ask({ type: "signin-continue", sessionId });
    else await ask({ type: "signin-denied", sessionId });
    $("retry").disabled = false;
    await refresh();
  });
});

$("cancel").addEventListener("click", async () => {
  $("cancel").disabled = true;
  const reply = await ask({ type: "signin-cancel", sessionId });
  if (!reply?.ok) await refresh();
});

$("close").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id).catch(() => undefined);
});

onSigninEvent(sessionId, (status) => render({ ...(page ?? {}), status }));
timer = setInterval(() => { void refresh(); }, REFRESH_MS);
void refresh();
