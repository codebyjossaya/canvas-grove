// Chrome-free Canvas Grove viewer. Renders only the remote browser surface via
// noVNC's core RFB client (served from NOVNC_ROOT next to this file) and keeps
// the postMessage contract the parent popup relies on:
//   { source: "canvas-grove-viewer", type: "shell-ready" | "ws-ready" | "disconnected" | "failed" | "signed-in-pending", detail }
// The parent may answer with { source: "canvas-grove-popup", type: "viewer-resume" }.
import { diffTextInput, isPasteShortcut, keysymForCodePoint, NAMED_KEYS, normalizePasteText, SOFT_KEYBOARD_SENTINEL, XK } from "./viewer-input.js";

const SOURCE = "canvas-grove-viewer";
const CONNECT_TIMEOUT_MS = 20_000;
const PASTE_KEY_DELAY_MS = 75; // lets x11vnc take ownership of CLIPBOARD before the keystroke

const root = document.documentElement;
const screen = document.getElementById("screen");
const message = document.getElementById("status-message");
const softKeyboard = document.getElementById("soft-keyboard");
const send = (type, detail) => window.parent.postMessage({ source: SOURCE, type, detail }, window.location.origin);
const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || "");

let rfb = null;
let connected = false;
let finished = false;
let failed = false;
let landed = false;
let events = null;
let heldControl = null;

const theme = /(?:^#|&)theme=(dark|light)(?:&|$)/.exec(window.location.hash)?.[1];
if (theme) root.dataset.theme = theme;

function show(state, text) {
  root.dataset.state = state;
  if (text) message.textContent = text;
}

function fail(detail) {
  if (connected || finished || failed || landed) return;
  failed = true;
  show("ended", "The secure browser could not connect. You can retry from this window.");
  send("failed", detail);
}

send("shell-ready");
addEventListener("error", () => { if (!connected) fail("A secure viewer module did not load."); }, true);
addEventListener("unhandledrejection", () => { if (!connected) fail("The secure viewer could not start."); });
const timeout = setTimeout(() => { if (!connected && !finished) fail("The secure browser did not establish a live connection."); }, CONNECT_TIMEOUT_MS);
addEventListener("beforeunload", () => { finished = true; clearTimeout(timeout); events?.close(); });

function websocketUrl() {
  // Same derivation vnc.html used for path=viewer/<id>/websockify, taken from
  // this page's own directory so no query parameter is needed.
  const base = window.location.pathname.replace(/[^/]*$/, "");
  if (!/^\/viewer\/[0-9a-f-]+\/$/.test(base)) return null;
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${base}websockify`;
}

function focusRemote() {
  if (!rfb || !connected || landed) return;
  if (document.activeElement === softKeyboard) return;
  const canvas = screen.querySelector("canvas");
  // noVNC makes its canvas focusable; make sure of it so keyboard and paste events land here.
  if (canvas && !canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
  rfb.focus();
}

// ---- Sign-in landed: blank immediately, never show the Canvas page or a disconnect.
function onLanded() {
  if (landed) return;
  landed = true;
  events?.close(); events = null;
  show("landed", "Finishing sign-in…");
  softKeyboard.blur();
  if (rfb) rfb.viewOnly = true;
  send("signed-in-pending");
}

function resumeAfterLanded() {
  if (!landed) return;
  landed = false;
  if (rfb) rfb.viewOnly = false;
  if (connected) { show("connected"); focusRemote(); return; }
  show("ended", "The secure browser connection closed.");
  send("disconnected", "The secure browser connection closed.");
}

addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  const data = event.data;
  if (data?.source !== "canvas-grove-popup") return;
  if (data.type === "viewer-resume") resumeAfterLanded();
  if (data.type === "visible-area" && Number.isFinite(data.bottom)) { parentVisibleBottom = data.bottom; applyKeyboardOffset(); }
});

function watchLanding() {
  if (events || landed || typeof EventSource !== "function") return;
  events = new EventSource("events");
  events.addEventListener("landed", onLanded);
}

// ---- Local -> remote paste. Remote -> local clipboard sync is intentionally
// absent: the RFB "clipboard" event is never subscribed to.
addEventListener("keydown", (event) => {
  if (event.code === "ControlLeft") heldControl = { keysym: XK.Control_L, code: "ControlLeft" };
  else if (event.code === "ControlRight") heldControl = { keysym: XK.Control_R, code: "ControlRight" };
  if (!rfb || !connected || landed || !isPasteShortcut(event, mac)) return;
  // Keep noVNC from forwarding (and cancelling) the V keystroke so the browser
  // still fires its native paste event; the default action must stay intact.
  event.stopImmediatePropagation();
}, true);
addEventListener("keyup", (event) => { if (event.code === heldControl?.code) heldControl = null; }, true);
addEventListener("blur", () => { heldControl = null; });

document.addEventListener("paste", (event) => {
  if (!rfb || !connected || landed) return;
  event.preventDefault();
  const text = normalizePasteText(event.clipboardData?.getData("text/plain") ?? "");
  if (text) pasteIntoRemote(text);
}, true);

function pasteIntoRemote(text) {
  const target = rfb;
  target.clipboardPasteFrom(text);
  setTimeout(() => {
    if (rfb !== target || !connected || landed) return;
    // The remote is Linux Chromium: always paste with Control_L, never Super.
    if (mac) { target.sendKey(XK.Super_L, "MetaLeft", false); target.sendKey(XK.Super_R, "MetaRight", false); }
    target.sendKey(XK.Control_L, "ControlLeft", true);
    target.sendKey(XK.v, "KeyV");
    target.sendKey(XK.Control_L, "ControlLeft", false);
    // If the user is still physically holding Ctrl, keep the remote in sync with it.
    if (heldControl) target.sendKey(heldControl.keysym, heldControl.code, true);
  }, PASTE_KEY_DELAY_MS);
}

// ---- Touch devices: a hidden textarea summons the on-screen keyboard; its
// edits are diffed and forwarded to the remote as keysyms.
let lastTouchY = null;
let softValue = SOFT_KEYBOARD_SENTINEL;
function resetSoftKeyboard() {
  softKeyboard.value = SOFT_KEYBOARD_SENTINEL;
  softValue = SOFT_KEYBOARD_SENTINEL;
  try { softKeyboard.setSelectionRange(softValue.length, softValue.length); } catch { /* not focusable yet */ }
}
resetSoftKeyboard();

function typeText(text) {
  for (const char of text) {
    const keysym = keysymForCodePoint(char.codePointAt(0));
    if (keysym !== null) rfb.sendKey(keysym, "");
  }
}

screen.addEventListener("pointerdown", (event) => {
  // noVNC's focus-on-click would move focus to the canvas and close the soft keyboard.
  if (rfb) rfb.focusOnClick = event.pointerType !== "touch";
}, true);
screen.addEventListener("touchend", (event) => {
  if (!rfb || !connected || landed) return;
  const touch = event.changedTouches?.[0];
  lastTouchY = touch ? touch.clientY : lastTouchY;
  if (lastTouchY !== null) softKeyboard.style.top = `${Math.max(0, Math.min(lastTouchY, window.innerHeight - 24))}px`;
  // Must run synchronously inside the touch gesture for iOS to open the keyboard.
  softKeyboard.focus({ preventScroll: true });
  resetSoftKeyboard();
}, { capture: true, passive: true });

softKeyboard.addEventListener("keydown", (event) => {
  if (!rfb || !connected || landed) return;
  if (event.isComposing || event.keyCode === 229) return; // IME/soft keyboard: handled by input diff
  if (isPasteShortcut(event, mac)) return; // native paste event follows
  const keysym = NAMED_KEYS[event.key];
  if (keysym === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  rfb.sendKey(keysym, event.code || "");
});
softKeyboard.addEventListener("input", () => {
  if (!rfb || !connected || landed) { resetSoftKeyboard(); return; }
  const { backspaces, text } = diffTextInput(softValue, softKeyboard.value);
  for (let i = 0; i < backspaces; i += 1) rfb.sendKey(XK.BackSpace, "Backspace");
  if (text) typeText(text);
  softValue = softKeyboard.value;
  // Keep the buffer bounded and the sentinel in place, but never mid-composition.
  if (!composing && (softValue.length > 2048 || softValue.length < SOFT_KEYBOARD_SENTINEL.length / 2)) resetSoftKeyboard();
});
let composing = false;
softKeyboard.addEventListener("compositionstart", () => { composing = true; });
softKeyboard.addEventListener("compositionend", () => { composing = false; });
softKeyboard.addEventListener("blur", () => { composing = false; resetSoftKeyboard(); applyKeyboardOffset(); });

// Keep the tapped remote field visible above the on-screen keyboard by shifting
// the surface up (scale is unchanged; noVNC maps pointers via the canvas rect).
// Inside the popup iframe our own visualViewport may not shrink for the
// keyboard, so the parent page also reports the visible bottom edge.
let parentVisibleBottom = Infinity;
function applyKeyboardOffset() {
  const vv = window.visualViewport;
  let shift = 0;
  if (document.activeElement === softKeyboard && lastTouchY !== null) {
    const ownBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const visibleBottom = Math.min(ownBottom, parentVisibleBottom);
    const keyboardOpen = visibleBottom < window.innerHeight * 0.85;
    if (keyboardOpen) shift = Math.min(lastTouchY, Math.max(0, lastTouchY + 56 - visibleBottom));
  }
  screen.style.transform = shift ? `translateY(${-Math.round(shift)}px)` : "";
}
window.visualViewport?.addEventListener("resize", applyKeyboardOffset);
window.visualViewport?.addEventListener("scroll", applyKeyboardOffset);
addEventListener("orientationchange", () => { lastTouchY = null; applyKeyboardOffset(); });

async function start() {
  const url = websocketUrl();
  if (!url) return fail("The secure viewer could not start.");
  let RFB;
  try { ({ default: RFB } = await import("./core/rfb.js")); }
  catch { return fail("A secure viewer module did not load."); }
  if (finished || failed) return;

  rfb = new RFB(screen, url, { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.showDotCursor = false;
  rfb.focusOnClick = true;
  rfb.viewOnly = false;
  rfb.background = "transparent";

  rfb.addEventListener("connect", () => {
    connected = true;
    clearTimeout(timeout);
    if (landed) return;
    show("connected");
    send("ws-ready");
    focusRemote();
    watchLanding();
  });
  rfb.addEventListener("disconnect", () => {
    const wasConnected = connected;
    connected = false;
    // After landing the session is being finalized and VNC is torn down on
    // purpose; the panel stays blank and the parent is not told.
    if (finished || landed) return;
    if (wasConnected) {
      show("ended", "The secure browser connection closed.");
      send("disconnected", "The secure browser connection closed.");
    } else {
      fail("The secure browser did not establish a live connection.");
    }
  });
  rfb.addEventListener("credentialsrequired", () => {
    fail("The secure browser did not establish a live connection.");
    rfb.disconnect();
  });
  addEventListener("focus", focusRemote);
}

start().catch(() => fail("The secure viewer could not start."));
