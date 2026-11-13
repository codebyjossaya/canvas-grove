import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diffTextInput, isPasteShortcut, keysymForCodePoint, MAX_PASTE_CHARS, normalizePasteText, SOFT_KEYBOARD_SENTINEL, XK } from "../services/browser-orchestrator/viewer/viewer-input.js";
import { canvasLanded } from "../services/browser-network-policy.mjs";
import { mobileLaunchEnv, validDisplay } from "../services/browser-orchestrator/display-policy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("services/browser-orchestrator/server.mjs");
const relay = read("services/browser-relay/server.mjs");
const dockerfile = read("services/browser-orchestrator/Dockerfile");
const html = read("services/browser-orchestrator/viewer/viewer.html");
const viewer = read("services/browser-orchestrator/viewer/viewer.js");
const startScript = read("browser/browser-image/start-browser.sh");
const popup = read("components/ui/secure-browser-popup.tsx");
const confirmRoute = read("app/api/canvas/sessions/[sessionId]/confirm/route.ts");
const worker = read("scripts/sync-worker.ts");

test("/live redirects to the chrome-free viewer with the same grant cookie attributes", () => {
  const redeem = server.slice(server.indexOf("const redeem = "), server.indexOf("const viewer = /^\\/viewer"));
  assert.match(redeem, /location: `\/viewer\/\$\{entry\.sessionId\}\/\$\{VIEWER_PAGE\}`/);
  assert.match(server, /const VIEWER_PAGE = "viewer\.html";/);
  // Max-Age covers the sliding grant's 30-minute hard cap (see signin-reliability.test.mjs).
  assert.match(redeem, /browser_view=\$\{grant\}; HttpOnly; Secure; SameSite=Strict; Path=\/viewer\/\$\{entry\.sessionId\}; Max-Age=\$\{Math\.round\(VIEWER_MAX_MS \/ 1000\)\}/);
  assert.match(redeem, /"cache-control": "no-store"/);
  assert.doesNotMatch(redeem, /vnc\.html/);
});

test("viewer assets keep path normalization and never serve noVNC's stock UI", () => {
  assert.match(server, /normalized\.startsWith\("\.\."\) \|\| normalized\.includes\("\\\\"\)/);
  assert.match(server, /NOVNC_UI_PAGES = new Set\(\["vnc\.html", "vnc_lite\.html"/);
  assert.match(server, /if \(NOVNC_UI_PAGES\.has\(normalized\)\) return null;/);
  assert.match(server, /readFile\(`\$\{own \? VIEWER_ROOT : NOVNC_ROOT\}\/\$\{normalized\}`\)/);
  assert.doesNotMatch(server, /viewerSignalScript/);
  assert.match(server, /asset\.name === VIEWER_PAGE \? "no-store" : asset\.own \? "private, no-cache" : "private, max-age=3600"/);
  assert.match(server, /"content-security-policy": viewerCsp\(req\.headers\.host\)/);
  assert.match(server, /script-src 'self'; style-src 'self'/);
  assert.match(server, /frame-ancestors 'self'/);
});

test("viewer page has no noVNC control-bar markup, no inline script, and fits the remote to the window", () => {
  for (const marker of ["noVNC_control_bar", "noVNC_clipboard", "noVNC_settings", "noVNC_keyboard_button", "noVNC_extra_keys"]) {
    assert.doesNotMatch(html + viewer, new RegExp(marker));
  }
  assert.match(html, /<script type="module" src="viewer\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>|<script type="module">|\son[a-z]+=/i, "no inline script or event handler attributes");
  assert.match(html, /<link rel="stylesheet" href="viewer\.css">/);
  assert.match(html, /Connecting to secure browser…/);
  assert.match(viewer, /import\("\.\/core\/rfb\.js"\)/);
  assert.match(viewer, /rfb\.scaleViewport = true;/);
  assert.match(viewer, /rfb\.resizeSession = false;/);
  assert.match(viewer, /rfb\.clipViewport = false;/);
  assert.match(viewer, /rfb\.showDotCursor = false;/);
  assert.match(viewer, /rfb\.focusOnClick = true;/);
  assert.match(viewer, /rfb\.viewOnly = false;/);
  assert.match(viewer, /\$\{base\}websockify/);
});

test("postMessage contract is unchanged and extended only with signed-in-pending", () => {
  assert.match(viewer, /const SOURCE = "canvas-grove-viewer";/);
  assert.match(viewer, /window\.parent\.postMessage\(\{ source: SOURCE, type, detail \}, window\.location\.origin\)/);
  for (const type of ["shell-ready", "ws-ready", "disconnected", "failed", "signed-in-pending"]) assert.match(viewer, new RegExp(`send\\("${type}"`));
  for (const detail of ["A secure viewer module did not load.", "The secure viewer could not start.", "The secure browser did not establish a live connection.", "The secure browser connection closed."]) {
    assert.ok(viewer.includes(detail), detail);
  }
  // authorization-expired still comes from the orchestrator's failure page.
  assert.match(server, /function viewerFailure\(res, status, message, type = "authorization-expired"\)/);
  assert.match(server, /source:'canvas-grove-viewer'/);
});

test("the orchestrator image copies every viewer file", () => {
  assert.match(dockerfile, /COPY viewer\/viewer\.html viewer\/viewer\.js viewer\/viewer\.css viewer\/viewer-input\.js \.\/viewer\//);
  assert.match(dockerfile, /display-policy\.mjs/);
  assert.match(server, /VIEWER_FILES = new Set\(\[VIEWER_PAGE, "viewer\.js", "viewer\.css", "viewer-input\.js"\]\)/);
});

test("paste sets the remote clipboard before the synthesized Control+V", () => {
  const paste = viewer.slice(viewer.indexOf("function pasteIntoRemote"), viewer.indexOf("// ---- Touch devices"));
  const set = paste.indexOf("target.clipboardPasteFrom(text)");
  const ctrlDown = paste.indexOf('target.sendKey(XK.Control_L, "ControlLeft", true)');
  const v = paste.indexOf('target.sendKey(XK.v, "KeyV")');
  const ctrlUp = paste.indexOf('target.sendKey(XK.Control_L, "ControlLeft", false)');
  assert.ok(set >= 0 && set < ctrlDown && ctrlDown < v && v < ctrlUp, "clipboardPasteFrom, then Control_L down, v, Control_L up");
  assert.match(paste, /setTimeout\(\(\) => \{[\s\S]*\}, PASTE_KEY_DELAY_MS\)/);
  assert.match(viewer, /event\.stopImmediatePropagation\(\);/);
  const shortcut = viewer.slice(viewer.indexOf('addEventListener("keydown"'), viewer.indexOf('addEventListener("keyup"'));
  // Only blocked browser-UI shortcuts are cancelled; Ctrl+V is never one, so the native paste event still fires.
  const pastePart = shortcut.slice(shortcut.indexOf("if (!isPasteShortcut(event, mac)) return;"));
  assert.doesNotMatch(pastePart, /preventDefault/, "the native paste event must still fire");
  assert.equal((shortcut.match(/preventDefault/g) || []).length, 1);
  assert.match(shortcut, /if \(isBrowserUiShortcut\(event\)\) \{ event\.preventDefault\(\);/);
  assert.match(viewer, /document\.addEventListener\("paste", \(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*normalizePasteText/);
  assert.equal(XK.Control_L, 0xffe3);
  assert.equal(XK.v, 0x76);
});

test("remote-to-local clipboard stays off", () => {
  assert.doesNotMatch(viewer, /addEventListener\("clipboard"/);
  assert.doesNotMatch(viewer, /navigator\.clipboard\.write/);
  assert.match(startScript, /x11vnc [^\n]*-seldir recv/);
  assert.doesNotMatch(startScript, /-noclipboard|-nosetclipboard|-nosel\b/);
});

test("paste text is normalized and capped", () => {
  assert.equal(normalizePasteText("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normalizePasteText(""), "");
  assert.equal(normalizePasteText(undefined), "");
  assert.equal(normalizePasteText("x".repeat(MAX_PASTE_CHARS + 10)).length, MAX_PASTE_CHARS);
  assert.equal(normalizePasteText(`ab\u{1F600}`, 3), "ab", "never splits a surrogate pair");
  assert.equal(isPasteShortcut({ code: "KeyV", ctrlKey: true }, false), true);
  assert.equal(isPasteShortcut({ code: "KeyV", metaKey: true }, true), true);
  assert.equal(isPasteShortcut({ code: "KeyV", ctrlKey: true }, true), false, "Ctrl+V on macOS is not paste");
  assert.equal(isPasteShortcut({ code: "KeyV", ctrlKey: true, altKey: true }, false), false, "AltGr+V is a character");
  assert.equal(isPasteShortcut({ code: "KeyC", ctrlKey: true }, false), false);
});

test("soft keyboard edits become BackSpace plus typed text", () => {
  assert.deepEqual(diffTextInput("__", "__h"), { backspaces: 0, text: "h" });
  assert.deepEqual(diffTextInput("__teh", "__the"), { backspaces: 2, text: "he" });
  assert.deepEqual(diffTextInput("__a", "__"), { backspaces: 1, text: "" });
  assert.deepEqual(diffTextInput("__", "__\u{1F600}"), { backspaces: 0, text: "\u{1F600}" });
  assert.equal(keysymForCodePoint("a".codePointAt(0)), 0x61);
  assert.equal(keysymForCodePoint(0xe9), 0xe9);
  assert.equal(keysymForCodePoint(0x20ac), 0x010020ac);
  assert.equal(keysymForCodePoint(0x0a), XK.Return);
  assert.equal(keysymForCodePoint(0x07), null);
  assert.ok(SOFT_KEYBOARD_SENTINEL.length > 0);
});

test("viewer has a hidden, focusable soft-keyboard textarea", () => {
  const textarea = /<textarea id="soft-keyboard"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(textarea, "soft-keyboard textarea present");
  for (const attribute of ['autocapitalize="off"', 'autocorrect="off"', 'spellcheck="false"', 'inputmode="text"', 'autocomplete="off"']) assert.ok(textarea.includes(attribute), attribute);
  assert.match(viewer, /softKeyboard\.focus\(\{ preventScroll: true \}\)/);
  assert.match(viewer, /softKeyboard\.addEventListener\("input"/);
  assert.match(viewer, /visualViewport\?\.addEventListener\("resize", applyKeyboardOffset\)/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /user-scalable=no/);
});

test("landing blanks the viewer and suppresses every later disconnect", () => {
  const landed = viewer.slice(viewer.indexOf("function onLanded"), viewer.indexOf("function resumeAfterLanded"));
  assert.match(landed, /show\("landed"/);
  assert.match(landed, /send\("signed-in-pending"\)/);
  const disconnect = viewer.slice(viewer.indexOf('rfb.addEventListener("disconnect"'), viewer.indexOf('rfb.addEventListener("credentialsrequired"'));
  assert.match(disconnect, /if \(finished \|\| landed\) return;/);
  assert.match(viewer, /function fail\(detail\) \{\n  if \(connected \|\| everConnected \|\| finished \|\| failed \|\| landed\) return;/);
  assert.match(viewer, /new EventSource\("events"\)/);
  assert.match(viewer, /events\.addEventListener\("landed", onLanded\)/);
  assert.match(read("services/browser-orchestrator/viewer/viewer.css"), /:root\[data-state="landed"\] \.screen, :root\[data-state="signed-in"\] \.screen \{ display: none; \}/);
});

test("viewer event stream is grant-authenticated and emits only the event type", () => {
  const route = server.slice(server.indexOf("const viewer = /^\\/viewer\\/([0-9a-f-]+)(\\/.*)$/"), server.indexOf("const { raw, value } = await readBody(req);"));
  const grantCheck = route.indexOf("viewerFailure(res, 401");
  const events = route.indexOf('viewer[2] === "/events"');
  assert.ok(grantCheck >= 0 && grantCheck < events, "grant check precedes the event stream");
  const stream = server.slice(server.indexOf("function serveViewerEvents"), server.indexOf("async function serveViewer("));
  assert.match(stream, /"content-type": "text\/event-stream; charset=utf-8", "cache-control": "no-store"/);
  assert.match(stream, /res\.write\("event: landed\\ndata: \{\}\\n\\n"\)/);
  assert.match(stream, /viewerGrants\.get\(grantKey\)/);
  assert.match(stream, /grant\.expiresAt < Date\.now\(\)/);
  assert.doesNotMatch(stream, /\burl\b|cookie/i);
  assert.match(relay, /m\[2\]==="landed"/);
  assert.match(relay, /send\(res,200,\{landed:/);
});

test("canvasLanded matches Canvas outside /login only", () => {
  const origin = "https://school.instructure.com";
  assert.equal(canvasLanded("https://school.instructure.com/", origin), true);
  assert.equal(canvasLanded("https://school.instructure.com/?login_success=1", origin), true);
  assert.equal(canvasLanded("https://school.instructure.com/courses/1", origin), true);
  assert.equal(canvasLanded("https://school.instructure.com/login/saml", origin), false);
  assert.equal(canvasLanded("https://school.instructure.com/login", origin), false);
  assert.equal(canvasLanded("https://school.instructure.com/login/canvas?x=1", origin), false);
  assert.equal(canvasLanded("https://idp.school.edu/", origin), false);
  assert.equal(canvasLanded("https://school.instructure.com.evil.test/", origin), false);
  assert.equal(canvasLanded("http://school.instructure.com/", origin), false);
  assert.equal(canvasLanded("not a url", origin), false);
});

test("popup hides the viewer on landing and closes only after server confirmation", () => {
  assert.match(popup, /message\.type === "signed-in-pending" \|\| message\.type === "signed-in"\) \{ void confirmSignIn\(\); return; \}/);
  assert.match(popup, /if \(finishing\.current \|\| ended\.current\) return;/);
  assert.match(popup, /\/api\/canvas\/sessions\/\$\{sessionId\}\/confirm/);
  assert.match(popup, /if \(value\.confirmed\) \{ finishSignedIn\(\); return; \}/);
  assert.match(popup, /FINISH_WINDOW_MS = 30_000/);
  // The remote view is never resumed after landing (the Canvas page is never shown).
  assert.doesNotMatch(popup, /type: "viewer-resume"/);
  assert.match(popup, /Finishing sign-in…/);
  assert.match(popup, /End session/);
  assert.match(popup, /you&apos;re signing in to/);
  assert.doesNotMatch(popup, /noVNC/i);
});

test("landed overlay can never be permanent: bounded finish window, status backup, viewer safety net", () => {
  // Popup: every confirm request is time-boxed and the loop ends within the window.
  assert.match(popup, /signal: AbortSignal\.timeout\(Math\.max\(1_000, Math\.min\(8_000, deadline - Date\.now\(\)\)\)\)/);
  assert.match(popup, /while \(Date\.now\(\) < deadline && !ended\.current && finishing\.current\)/);
  const loop = popup.slice(popup.indexOf("const confirmSignIn = useCallback"), popup.indexOf("}, [finishSignedIn, sessionId]);"));
  const tail = loop.slice(loop.lastIndexOf("if (ended.current || !finishing.current) return;"));
  assert.match(tail, /finishing\.current = false;/);
  assert.match(tail, /setStage\("error"\); setErrorCode\("SIGN_IN_NOT_FINISHED"\)/);
  assert.doesNotMatch(tail, /viewer-resume|setStage\("ready"\)/);
  // The server-side monitor's completion is seen through the status endpoint.
  assert.match(loop, /if \(value\.session\.state === "active"\) \{ finishSignedIn\(\); return; \}/);
  // Duplicate signed-in-pending is a no-op while finishing.
  assert.match(popup, /if \(!sessionId \|\| finishing\.current \|\| ended\.current\) return;/);
  // The status poll always runs (even with the opener present).
  assert.doesNotMatch(popup, /window\.opener && !window\.opener\.closed && !unconfirmed/);
  // Viewer: bounded timeout leaves the overlay for an actionable, still-hidden message.
  assert.match(viewer, /const LANDED_STUCK_MS = 40_000;/);
  const landed = viewer.slice(viewer.indexOf("function onLanded"), viewer.indexOf("function resumeAfterLanded"));
  assert.match(landed, /landedTimer = setTimeout/);
  assert.match(landed, /show\("ended", "Sign-in did not finish/);
  assert.match(landed, /send\("failed", "Sign-in confirmation timed out\."\)/);
  assert.doesNotMatch(landed, /landed = false/, "safety net must not reveal the Canvas page");
  const resume = viewer.slice(viewer.indexOf("function resumeAfterLanded"), viewer.indexOf('addEventListener("message", (event)'));
  assert.match(resume, /clearTimeout\(landedTimer\)/);
  assert.match(viewer, /beforeunload", \(\) => \{ finished = true; clearTimeout\(timeout\); clearTimeout\(landedTimer\); clearTimeout\(reconnectTimer\)/);
});

test("confirm route authenticates, rate limits, and shares the worker's finalizer", () => {
  const auth = confirmRoute.indexOf("if (!authSession.isAuthenticated || !authSession.userId) return errorJson");
  const limit = confirmRoute.indexOf("checkRateLimit(RATE_LIMITS.authConfirm, ownerId)");
  const owner = confirmRoute.indexOf("hostedSessionStore.getForOwner(sessionId, ownerId)");
  const provider = confirmRoute.indexOf("hostedBrowserProvider.status(");
  assert.ok(auth >= 0 && auth < limit && limit < owner && owner < provider, "auth, then rate limit, then ownership, then provider access");
  assert.match(confirmRoute, /completeAuthenticationTx\(tx, monitor,/);
  // Login-only browser: the winner revokes the viewer and terminates the browser.
  assert.match(confirmRoute, /after\(\(\) => releaseLoginBrowser\(hostedBrowserProvider, providerSessionId\)/);
  assert.match(worker, /completeAuthenticationTx\(tx, monitor, canvasUserId, encrypted\)/);
  assert.doesNotMatch(worker, /insert into canvas_accounts/, "one implementation, in lib/bridge/complete-authentication.ts");
  assert.match(read("lib/rate-limit.ts"), /authConfirm: \{ name: "auth-confirm"/);
});

test("display policy accepts mobile portrait profiles and keeps desktop unchanged", () => {
  assert.deepEqual(validDisplay({ width: 1280, height: 720 }), { width: 1280, height: 720 });
  assert.equal(validDisplay({ width: 640, height: 480 }), null);
  assert.deepEqual(validDisplay({ mobile: true, cssWidth: 390, cssHeight: 780, dpr: 2 }), { width: 780, height: 1560, mobile: true, cssWidth: 390, cssHeight: 780, dpr: 2 });
  assert.deepEqual(validDisplay({ mobile: true, cssWidth: 360, cssHeight: 640, dpr: 3 }), { width: 1080, height: 1920, mobile: true, cssWidth: 360, cssHeight: 640, dpr: 3 });
  for (const absurd of [
    { mobile: true, cssWidth: 100, cssHeight: 700, dpr: 2 },
    { mobile: true, cssWidth: 390, cssHeight: 5000, dpr: 2 },
    { mobile: true, cssWidth: 390, cssHeight: 844, dpr: 3 }, // over the pixel cap
    { mobile: true, cssWidth: 390, cssHeight: 780, dpr: 9 },
    { mobile: true, cssWidth: 390, cssHeight: 780, dpr: 1.3 },
    { mobile: true, cssWidth: 390.5, cssHeight: 780, dpr: 2 },
    { mobile: true, cssWidth: 390, cssHeight: 780, dpr: "2" },
    { mobile: true, width: 99999, height: 99999 },
  ]) assert.equal(validDisplay(absurd), null, JSON.stringify(absurd));
});

test("launchBrowser passes mobile environment only for mobile profiles", () => {
  assert.deepEqual(mobileLaunchEnv({ width: 1280, height: 720 }), []);
  assert.deepEqual(mobileLaunchEnv(undefined), []);
  assert.deepEqual(mobileLaunchEnv({ width: 780, height: 1560, mobile: true, cssWidth: 390, cssHeight: 780, dpr: 2 }),
    ["-e", "BROWSER_MOBILE=1", "-e", "BROWSER_CSS_WIDTH=390", "-e", "BROWSER_CSS_HEIGHT=780", "-e", "BROWSER_DPR=2"]);
  const launch = server.match(/async function launchBrowser\([\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(launch, /\.\.\.mobileLaunchEnv\(display\),\n\s*IMAGE, String\(display\.width\), String\(display\.height\)\]/);
  assert.match(server, /display\.mobile \? -1 : warmPool\.findIndex/, "mobile never claims a desktop warm browser");
});

test("start-browser.sh applies mobile Chromium flags only when BROWSER_MOBILE=1 and keeps policy flags", () => {
  const mobile = startScript.slice(startScript.indexOf('if [ "${BROWSER_MOBILE:-0}" = "1" ]; then'), startScript.indexOf("\nfi\n"));
  assert.match(mobile, /--user-agent="Mozilla\/5\.0 \(Linux; Android 10; K\)[^"]*Mobile Safari\/537\.36"/);
  assert.match(mobile, /--force-device-scale-factor="\$DPR"/);
  assert.match(mobile, /--touch-events=enabled/);
  assert.match(mobile, /case "\$DPR" in/);
  assert.match(mobile, /MIN_WINDOW_WIDTH=500/, "phones narrower than Chromium's 500 DIP minimum window are scaled to fit, not clipped");
  assert.match(mobile, /DPR="\$\(awk -v w="\$WIDTH" -v m="\$MIN_WINDOW_WIDTH"/);
  assert.match(startScript, /^set --$/m, "desktop gets an empty extra-argument list");
  assert.match(startScript, /--window-size="\$\{WINDOW_WIDTH\},\$\{WINDOW_HEIGHT\}"/);
  assert.match(startScript, /"\$@" \\\n  about:blank/);
  for (const flag of ["--disable-extensions-except=/opt/canvas-grove/no-passkeys", "--load-extension=/opt/canvas-grove/no-passkeys", "--disable-features=WebAuthenticationCable"]) assert.ok(startScript.includes(flag), flag);
  assert.equal((startScript.match(/--disable-features=/g) ?? []).length, 1, "a second --disable-features would override the first");
});
