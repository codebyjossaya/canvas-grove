// Chrome-free Canvas Grove viewer. Renders only the remote browser surface via
// noVNC's core RFB client (served from NOVNC_ROOT next to this file) and keeps
// the postMessage contract the parent popup relies on:
//   { source: "canvas-grove-viewer", type: "shell-ready" | "ws-ready" | "disconnected" | "failed" | "signed-in-pending" | "signed-in", detail }
// The parent may answer with { source: "canvas-grove-popup", type: "viewer-complete" | "viewer-resume" }.
import { diffTextInput, isBrowserUiShortcut, isPasteShortcut, keysymForCodePoint, NAMED_KEYS, normalizePasteText, SOFT_KEYBOARD_SENTINEL, XK } from "./viewer-input.js";

const SOURCE = "canvas-grove-viewer";
const CONNECT_TIMEOUT_MS = 20_000;
// Safety net when nothing reports completion (no parent window, or the server
// never released the browser). The popup itself gives up after 30 s.
const LANDED_STUCK_MS = 40_000;
// Transparent reconnects of the pixel stream before the parent is told.
const RECONNECT_DELAYS_MS = [400, 1500, 4000];
// A stream that answers none of the user's input for this long is reconnected.
const STALL_MS = 5_000;
const PASTE_KEY_DELAY_MS = 75; // lets x11vnc take ownership of CLIPBOARD before the keystroke

const root = document.documentElement;
const screen = document.getElementById("screen");
const message = document.getElementById("status-message");
const softKeyboard = document.getElementById("soft-keyboard");
const send = (type, detail) => window.parent.postMessage({ source: SOURCE, type, detail }, window.location.origin);
const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || "");

// Count inbound stream traffic (noVNC opens its socket through the global WebSocket).
let lastFrameAt = 0;
const NativeWebSocket = window.WebSocket;
if (typeof NativeWebSocket === "function") {
  // Return a plain native socket, never a subclass: noVNC's Websock.attach()
  // only looks one prototype deep for send/close/onmessage..., so a subclass
  // makes every `new RFB()` throw "Raw channel missing property: send".
  const TrackedWebSocket = function TrackedWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    socket.addEventListener("message", () => { lastFrameAt = Date.now(); });
    return socket;
  };
  TrackedWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) TrackedWebSocket[key] = NativeWebSocket[key];
  window.WebSocket = TrackedWebSocket;
}

let rfb = null;
let connected = false;
let everConnected = false;
let reconnectAttempt = 0;
let reconnectTimer = 0;
let finished = false;
let failed = false;
let landed = false;
let landedTimer = null;
let events = null;
let heldControl = null;
// Renderer: "pixels" (noVNC) or "mirror" (sanitized DOM). The orchestrator
// decides per grant (SIGNIN_RENDERER, dev/test override); "mirror" falls back
// to pixels per page and returns after the next navigation.
let renderer = "pixels";
let focusEvents = false;
let mirror = null;
let surface = "pixels";
let autoFallback = false;
let manualClassic = false;
let retiredRfb = null;
let remoteFocus = null;
let lastTapAt = 0;
const notice = document.getElementById("notice");
const mirrorRoot = document.getElementById("mirror");

const theme = /(?:^#|&)theme=(dark|light)(?:&|$)/.exec(window.location.hash)?.[1];
if (theme) root.dataset.theme = theme;

function show(state, text) {
  root.dataset.state = state;
  if (text) message.textContent = text;
}

function fail(detail) {
  if (connected || everConnected || finished || failed || landed) return;
  failed = true;
  show("ended", "The secure browser could not connect. You can retry from this window.");
  send("failed", detail);
}

send("shell-ready");
// Only our own same-origin scripts are fatal. A proxy/CDN in front of the
// gateway (Cloudflare injects beacon.min.js) gets its script blocked by the
// viewer CSP; that error must not abort the viewer before it connects.
addEventListener("error", (event) => {
  if (connected) return;
  const target = event.target;
  if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
    const src = target.src || target.href || "";
    if (!src.startsWith(`${window.location.origin}/`)) { console.warn(`secure viewer: ignoring a third-party resource that failed to load: ${src.split("?", 1)[0]}`); return; }
    return fail(`A secure viewer module did not load (${src.slice(window.location.origin.length).split("?", 1)[0]}).`);
  }
  if (target === window && event.filename && !event.filename.startsWith(`${window.location.origin}/`)) return;
  fail("A secure viewer module did not load.");
}, true);
addEventListener("unhandledrejection", () => { if (!connected) fail("The secure viewer could not start."); });
const timeout = setTimeout(() => { if (!connected && !finished) fail("The secure browser did not establish a live connection."); }, CONNECT_TIMEOUT_MS);
addEventListener("beforeunload", () => { finished = true; clearTimeout(timeout); clearTimeout(landedTimer); clearTimeout(reconnectTimer); events?.close(); });

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
  clearTimeout(reconnectTimer); hideRefresh();
  // The events stream stays open: the server reports when it has saved the
  // session ("closed" with reason "signed-in"), with or without a parent window.
  show("landed", "Finishing sign-in…");
  softKeyboard.blur();
  if (rfb) rfb.viewOnly = true;
  send("signed-in-pending");
  // If nothing ever reports completion, leave the overlay for an actionable
  // message. `landed` stays true so the Canvas page is never shown.
  landedTimer = setTimeout(() => {
    if (!landed || finished) return;
    finished = true;
    show("ended", "Sign-in did not finish. Close this window and start a new secure sign-in from Canvas Grove.");
    send("failed", "Sign-in confirmation timed out.");
  }, LANDED_STUCK_MS);
}

function onSignedIn() {
  if (finished && root.dataset.state === "signed-in") return;
  landed = true; finished = true;
  clearTimeout(landedTimer); clearTimeout(reconnectTimer); hideRefresh();
  events?.close(); events = null;
  if (rfb) { rfb.viewOnly = true; try { rfb.disconnect(); } catch { /* already closed */ } }
  show("signed-in", "Signed in ✓ You can close this window.");
  send("signed-in");
}

function onClosed(event) {
  let reason = "ended";
  try { reason = JSON.parse(event.data)?.reason || "ended"; } catch { /* default */ }
  events?.close(); events = null;
  if (reason === "signed-in") return onSignedIn();
  if (finished) return;
  finished = true; clearTimeout(landedTimer); clearTimeout(reconnectTimer); hideRefresh();
  if (landed) {
    // Never fall back to the remote page after landing.
    show("ended", "Sign-in did not finish. Close this window and start a new secure sign-in from Canvas Grove.");
    send("failed", "The secure browser closed before sign-in finished.");
    return;
  }
  // The session was ended or replaced on the server: reconnecting cannot help.
  show("ended", "The secure browser connection closed.");
  send("disconnected", "The secure browser connection closed.");
}

function resumeAfterLanded() {
  if (!landed || finished) return;
  clearTimeout(landedTimer);
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
  if (data.type === "viewer-complete") onSignedIn();
  if (data.type === "renderer-toggle" && renderer === "mirror" && mirror) {
    if (surface === "mirror") { manualClassic = true; switchToPixels(null); } else { manualClassic = false; switchToMirror(); }
  }
  if (data.type === "visible-area" && Number.isFinite(data.bottom)) { parentVisibleBottom = data.bottom; applyKeyboardOffset(); }
});

function watchLanding() {
  if (events && events.readyState !== 2) return; // 2 = CLOSED (e.g. grant renewed after a reconnect)
  if (landed || typeof EventSource !== "function") return;
  events = new EventSource("events");
  events.addEventListener("landed", onLanded);
  events.addEventListener("closed", onClosed);
  if (focusEvents) events.addEventListener("focus", onRemoteFocus);
}

// ---- Pixel-mode keyboard fix: the orchestrator reports only whether the
// remote focused element is editable, its input type and its rectangle (as
// fractions of the remote viewport). The hidden textarea is focused only for
// taps on that editable element, so other taps never raise the keyboard.
function onRemoteFocus(event) {
  let value;
  try { value = JSON.parse(event.data); } catch { return; }
  remoteFocus = { editable: value?.editable === true, rect: value?.rect && typeof value.rect === "object" ? value.rect : null };
  if (!rfb || !connected || landed || surface !== "pixels") return;
  if (!remoteFocus.editable) { if (document.activeElement === softKeyboard) softKeyboard.blur(); return; }
  // A tap just moved remote focus into a field: open the keyboard now (Android
  // honours this within the tap's user activation; iOS needs the next tap).
  if (Date.now() - lastTapAt < 1500 && document.activeElement !== softKeyboard) { softKeyboard.focus({ preventScroll: true }); resetSoftKeyboard(); }
}

function tapHitsEditable(touch) {
  const rect = remoteFocus?.editable ? remoteFocus.rect : null;
  const canvas = screen.querySelector("canvas");
  if (!rect || !canvas || !touch) return false;
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const x = (touch.clientX - box.left) / box.width, y = (touch.clientY - box.top) / box.height, margin = 0.01;
  return x >= rect.x - margin && x <= rect.x + rect.w + margin && y >= rect.y - margin && y <= rect.y + rect.h + margin;
}

// ---- Local -> remote paste. Remote -> local clipboard sync is intentionally
// absent: the RFB "clipboard" event is never subscribed to.
addEventListener("keydown", (event) => {
  if (event.code === "ControlLeft") heldControl = { keysym: XK.Control_L, code: "ControlLeft" };
  else if (event.code === "ControlRight") heldControl = { keysym: XK.Control_R, code: "ControlRight" };
  if (!rfb || !connected || landed) return;
  // Browser-UI shortcuts (omnibox, new window/tab, DevTools…) never reach the
  // remote Chromium: its UI would cover the sign-in page and swallow clicks.
  if (isBrowserUiShortcut(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (!["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(event.key)) noteInput();
  if (!isPasteShortcut(event, mac)) return;
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
  lastTapAt = Date.now();
  if (focusEvents && remoteFocus && !tapHitsEditable(touch)) {
    if (document.activeElement === softKeyboard) softKeyboard.blur();
    return;
  }
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

// ---- Stalled-stream detection: input the remote never answers (no inbound
// stream bytes at all) means a dead or wedged connection, not an idle page.
let pendingInputAt = 0;
let pendingInputs = 0;
let lastStallReconnectAt = 0;
const refreshButton = document.getElementById("refresh");
function noteInput() {
  if (!connected || landed || surface !== "pixels") return;
  if (!pendingInputAt || lastFrameAt > pendingInputAt) { pendingInputAt = Date.now(); pendingInputs = 0; }
  pendingInputs += 1;
}
function hideRefresh() { if (refreshButton) refreshButton.hidden = true; }
setInterval(() => {
  if (!rfb || !connected || landed || finished || surface !== "pixels" || !pendingInputAt) return;
  if (lastFrameAt > pendingInputAt) { pendingInputAt = 0; pendingInputs = 0; return; }
  if (pendingInputs < 2 || Date.now() - pendingInputAt < STALL_MS) return;
  pendingInputAt = 0; pendingInputs = 0;
  if (Date.now() - lastStallReconnectAt > 30_000) { lastStallReconnectAt = Date.now(); reconnectNow(); return; }
  // Reconnecting did not help: let the user retry explicitly.
  if (refreshButton) refreshButton.hidden = false;
}, 1_000);
refreshButton?.addEventListener("click", () => {
  hideRefresh();
  reconnectNow(true);
});

/** Drop the current stream and open a new one on the same grant (no remote state changes). */
function reconnectNow(escape = false) {
  if (landed || finished || surface !== "pixels") return;
  const old = rfb;
  if (old) { retiredRfb = old; rfb = null; connected = false; try { old.disconnect(); } catch { retiredRfb = null; } }
  show("reconnecting", "Reconnecting to the secure browser…");
  start({ escape }).catch(() => scheduleReconnect());
}

function scheduleReconnect() {
  if (landed || finished) return;
  if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
    show("ended", "The secure browser connection closed.");
    send("disconnected", "The secure browser connection closed.");
    return;
  }
  const delay = RECONNECT_DELAYS_MS[reconnectAttempt++];
  show("reconnecting", "Reconnecting to the secure browser…");
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (!landed && !finished) start().catch(() => scheduleReconnect()); }, delay);
}

let focusListener = false;
async function start({ escape = false } = {}) {
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

  const current = rfb;
  rfb.addEventListener("connect", () => {
    if (rfb !== current) return;
    connected = true; everConnected = true; reconnectAttempt = 0;
    lastFrameAt = Date.now(); pendingInputAt = 0; pendingInputs = 0;
    clearTimeout(timeout);
    if (landed) return;
    show("connected");
    send("ws-ready");
    focusRemote();
    watchLanding();
    // "Tap to refresh": an Escape closes a stray remote bubble or panel.
    if (escape) { current.sendKey(XK.Escape, "Escape"); }
  });
  rfb.addEventListener("disconnect", () => {
    // Retired on purpose because the page view took over again, or replaced by a reconnect.
    if (retiredRfb === current) { retiredRfb = null; return; }
    if (rfb !== current) return;
    connected = false;
    // After landing the session is being finalized and VNC is torn down on
    // purpose; the panel stays blank and the parent is not told.
    if (finished || landed) return;
    rfb = null;
    // Drops (network blips, a restarted relay) reconnect on the same sliding
    // grant without the user doing anything; only repeated failure is reported.
    if (everConnected) scheduleReconnect();
    else fail("The secure browser did not establish a live connection.");
  });
  rfb.addEventListener("credentialsrequired", () => {
    fail("The secure browser did not establish a live connection.");
    current.disconnect();
  });
  if (!focusListener) { focusListener = true; addEventListener("focus", focusRemote); }
}
screen.addEventListener("pointerdown", () => noteInput(), true);

// ---- DOM mirror (renderer "mirror") with per-page fallback to pixels.
const FALLBACK_NOTICES = {
  captcha: "This page has a security check, so it is shown in classic view.",
  frame: "This page embeds content from another site, so it is shown in classic view.",
  canvas: "This page draws graphics, so it is shown in classic view.",
  size: "This page is very large, so it is shown in classic view.",
  error: "This page could not be shown as a page view, so it is shown in classic view.",
};
const BLANK_FALLBACK_MS = 2_500;
let blankTimer = 0;
let noticeTimer = 0;
function showNotice(text) {
  clearTimeout(noticeTimer);
  notice.textContent = text; notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function setSurface(next) {
  surface = next;
  root.dataset.surface = next;
  send("renderer", next === "mirror" ? "mirror" : autoFallback ? "pixels-auto" : "pixels");
}

function switchToPixels(reason) {
  if (!mirror || landed) return;
  autoFallback = Boolean(reason);
  setSurface("pixels");
  mirror.setVisible(false);
  if (reason && FALLBACK_NOTICES[reason]) showNotice(FALLBACK_NOTICES[reason]);
  if (!rfb) start().catch((error) => fail(`The secure viewer could not start (pixel view: ${error?.message || error}).`));
  else { show("connected"); focusRemote(); }
}

function switchToMirror() {
  if (!mirror || landed || !mirror.ready) return;
  autoFallback = false;
  setSurface("mirror");
  mirror.setVisible(true);
  if (rfb) {
    // Free the VNC stream while the page view is active.
    retiredRfb = rfb; const old = rfb; rfb = null;
    try { old.disconnect(); } catch { retiredRfb = null; }
  }
  show("connected");
}

const jsDialog = document.getElementById("js-dialog");
const jsDialogText = document.getElementById("js-dialog-text");
function answerDialog(accept) { jsDialog.hidden = true; void mirror?.answerDialog(accept); }
document.getElementById("js-dialog-ok").addEventListener("click", () => answerDialog(true));
document.getElementById("js-dialog-cancel").addEventListener("click", () => answerDialog(false));

async function startMirror() {
  let createMirror;
  try { ({ createMirror } = await import("./mirror-client.js")); }
  catch { renderer = "pixels"; return start(); }
  setSurface("mirror");
  mirror = createMirror({
    container: mirrorRoot,
    onReady: () => {
      if (landed || finished) return;
      connected = true;
      clearTimeout(timeout);
      if (surface === "mirror") show("connected");
      send("ws-ready");
      watchLanding();
    },
    onFallback: (reason) => { if (surface === "mirror") switchToPixels(reason || "error"); },
    onRestore: () => { if (autoFallback && !manualClassic) switchToMirror(); },
    onUnavailable: () => { if (!mirror?.ready) switchToPixels("error"); },
    // The remote page may not be mirrored. Signed-in Canvas: stay hidden, the
    // "landed" event follows. Anything else (browser error page, about:blank):
    // show it in the pixel view unless a mirrorable page arrives first.
    onBlank: (isLanded) => {
      clearTimeout(blankTimer);
      if (isLanded) return;
      blankTimer = setTimeout(() => { if (mirror?.blank && surface === "mirror" && !landed && !finished) switchToPixels("blank"); }, BLANK_FALLBACK_MS);
    },
    onDialog: (dialog) => {
      if (surface !== "mirror") return;
      jsDialog.dataset.type = dialog.type === "alert" || dialog.type === "beforeunload" ? "alert" : "confirm";
      jsDialogText.textContent = dialog.message || "";
      jsDialog.hidden = false;
    },
    onDialogClosed: () => { jsDialog.hidden = true; },
  });
  mirror.start();
  // If the page view cannot render in time, show the classic view instead of failing.
  setTimeout(() => { if (mirror && !mirror.ready && !landed && !finished && surface === "mirror") switchToPixels("error"); }, CONNECT_TIMEOUT_MS / 2);
}

async function boot() {
  let mode = null;
  try {
    const response = await fetch("mode", { cache: "no-store", credentials: "same-origin" });
    if (response.ok) mode = await response.json();
  } catch { /* default to pixels */ }
  renderer = mode?.renderer === "mirror" ? "mirror" : "pixels";
  focusEvents = mode?.focusEvents === true;
  root.dataset.renderer = renderer;
  if (renderer === "mirror") return startMirror();
  return start();
}

boot().catch((error) => fail(`The secure viewer could not start (${error?.message || error}).`));
