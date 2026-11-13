// Hosted sign-in reliability: browser-UI lockdown, viewer resilience
// (sliding grants, reconnect, stall detection) and server-side completion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isBrowserUiShortcut } from "../services/browser-orchestrator/viewer/viewer-input.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("services/browser-orchestrator/server.mjs");
const relay = read("services/browser-relay/server.mjs");
const viewer = read("services/browser-orchestrator/viewer/viewer.js");
const viewerHtml = read("services/browser-orchestrator/viewer/viewer.html");
const popup = read("components/ui/secure-browser-popup.tsx");
const provider = read("lib/bridge/providers/self-hosted.ts");
const completion = read("lib/bridge/complete-authentication.ts");
const worker = read("scripts/sync-worker.ts");
const compose = read("compose.yaml");
const policy = JSON.parse(read("browser/browser-image/chromium-policy.json"));

const key = (code, mods = {}, key = undefined) => ({ code, key: key ?? (code.startsWith("Key") ? code.slice(3).toLowerCase() : code), ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("browser-UI shortcuts are never forwarded to the hosted Chromium", () => {
  const blocked = [
    key("F6"), key("F12"), key("F7"), key("F10"), key("F11"), key("F1"), key("F3"), key("F4", { altKey: true }), key("F4", { ctrlKey: true }),
    key("KeyL", { ctrlKey: true }), key("KeyT", { ctrlKey: true }), key("KeyN", { ctrlKey: true }), key("KeyW", { ctrlKey: true }),
    key("KeyH", { ctrlKey: true }), key("KeyJ", { ctrlKey: true }), key("KeyU", { ctrlKey: true }), key("KeyP", { ctrlKey: true }),
    key("KeyS", { ctrlKey: true }), key("KeyF", { ctrlKey: true }), key("KeyK", { ctrlKey: true }), key("KeyE", { ctrlKey: true }), key("KeyD", { ctrlKey: true }), key("KeyO", { ctrlKey: true }),
    key("KeyJ", { ctrlKey: true, shiftKey: true }), key("KeyI", { ctrlKey: true, shiftKey: true }), key("KeyC", { ctrlKey: true, shiftKey: true }),
    key("KeyN", { ctrlKey: true, shiftKey: true }), key("KeyT", { ctrlKey: true, shiftKey: true }), key("KeyB", { ctrlKey: true, shiftKey: true }),
    key("Delete", { ctrlKey: true, shiftKey: true }), key("Tab", { ctrlKey: true }), key("Tab", { ctrlKey: true, shiftKey: true }),
    key("PageDown", { ctrlKey: true }), key("Digit1", { ctrlKey: true }), key("Digit9", { ctrlKey: true }), key("Equal", { ctrlKey: true }), key("Minus", { ctrlKey: true }), key("Digit0", { ctrlKey: true }),
    key("KeyD", { altKey: true }), key("KeyE", { altKey: true }), key("KeyF", { altKey: true }), key("Home", { altKey: true }),
    key("KeyI", { altKey: true, shiftKey: true }, "I"), key("KeyT", { altKey: true, shiftKey: true }, "T"), key("Escape", { shiftKey: true }),
  ];
  for (const event of blocked) assert.equal(isBrowserUiShortcut(event), true, JSON.stringify(event));
});

test("typing, editing, paste and AltGr/Option characters still reach the sign-in page", () => {
  const allowed = [
    key("KeyA"), key("KeyL"), key("Digit1"), key("Enter"), key("Backspace"), key("Tab"), key("Escape"), key("Space"), key("ArrowLeft"), key("F5"),
    key("KeyA", { shiftKey: true }, "A"), key("KeyA", { ctrlKey: true }), key("KeyC", { ctrlKey: true }), key("KeyV", { ctrlKey: true }),
    key("KeyX", { ctrlKey: true }), key("KeyZ", { ctrlKey: true }), key("KeyY", { ctrlKey: true }), key("KeyR", { ctrlKey: true }),
    key("KeyZ", { ctrlKey: true, shiftKey: true }), key("KeyV", { ctrlKey: true, shiftKey: true }),
    key("Backspace", { ctrlKey: true }), key("ArrowLeft", { ctrlKey: true }), key("ArrowRight", { ctrlKey: true, shiftKey: true }), key("Home", { ctrlKey: true }),
    key("ArrowLeft", { altKey: true }), key("ArrowRight", { altKey: true }),
    // AltGr on Windows/Linux reports Ctrl+Alt: "@" on a German layout is AltGr+Q.
    key("KeyQ", { ctrlKey: true, altKey: true }, "@"), key("KeyE", { ctrlKey: true, altKey: true }, "€"),
    // macOS Option+letter produces a character (Option+L is "@" on a German Mac layout).
    key("KeyL", { altKey: true }, "@"), key("KeyD", { altKey: true }, "∂"), key("KeyF", { altKey: true }, "ƒ"),
    // macOS Cmd is Super on the remote Linux and triggers no Chromium shortcut.
    key("KeyL", { metaKey: true }), key("KeyT", { metaKey: true }),
  ];
  for (const event of allowed) assert.equal(isBrowserUiShortcut(event), false, JSON.stringify(event));
  assert.equal(isBrowserUiShortcut(null), false);
  assert.equal(isBrowserUiShortcut({}), false);
});

test("the viewer drops browser-UI shortcuts before noVNC sees them", () => {
  const listener = viewer.slice(viewer.indexOf('addEventListener("keydown", (event) => {'), viewer.indexOf('addEventListener("keyup"'));
  assert.match(listener, /if \(isBrowserUiShortcut\(event\)\) \{ event\.preventDefault\(\); event\.stopImmediatePropagation\(\); return; \}/);
  assert.match(listener, /\}, true\);/, "capture phase on window runs before noVNC's canvas handler");
  assert.ok(listener.indexOf("isBrowserUiShortcut") < listener.indexOf("isPasteShortcut"));
});

test("managed policy keeps stray windows inert and closable without breaking CDP", () => {
  // DeveloperToolsAvailability=2 also blocks CDP page attach (Playwright sees no
  // pages), which would break sign-in detection. DevTools is blocked by URL instead.
  assert.equal(policy.DeveloperToolsAvailability, undefined);
  for (const pattern of ["devtools://*", "view-source:*", "file://*"]) assert.ok(policy.URLBlocklist.includes(pattern), pattern);
  // chrome://* must NOT be blocklisted: it turns the omnibox's built-in browser_ui
  // targets into closable page targets.
  assert.ok(!policy.URLBlocklist.some((pattern) => pattern.startsWith("chrome://")));
  // New tab/window stays on chrome: (closed by the relay guard) instead of a
  // third-party new-tab redirect that would trip the host guard.
  assert.equal(policy.NewTabPageLocation, "chrome://version/");
  assert.equal(policy.IncognitoModeAvailability, 1);
  assert.equal(policy.BrowserGuestModeEnabled, false);
  assert.equal(policy.DownloadRestrictions, 3);
  assert.equal(policy.PrintingEnabled, false);
});

test("relay closes browser-UI and view-source tabs instead of ending the sign-in", () => {
  assert.match(relay, /BROWSER_UI_SCHEMES=new Set\(\["chrome:","devtools:","chrome-untrusted:","view-source:"\]\)/);
  assert.match(relay, /\/json\/close\/\$\{t\.id\}/);
});

test("viewer grant slides with activity up to a 30-minute hard cap", () => {
  assert.match(server, /const VIEWER_IDLE_MS = 5 \* 60_000, VIEWER_MAX_MS = 30 \* 60_000;/);
  assert.match(server, /\{ kind: "viewer", ttlSeconds: Math\.round\(VIEWER_MAX_MS \/ 1000\) \}/);
  assert.match(server, /Max-Age=\$\{Math\.round\(VIEWER_MAX_MS \/ 1000\)\}/);
  assert.match(relay, /const VIEWER_MAX_TTL_SECONDS = 1800;/);
  assert.match(relay, /value\.kind==="mirror"\?900:VIEWER_MAX_TTL_SECONDS/);
  assert.match(relay, /kind==="viewer"\?VIEWER_MAX_TTL_SECONDS\*1000/);
  // Viewer requests, websocket upgrades, events ticks and open sockets renew it.
  assert.ok((server.match(/touchGrant\(grant\)/g) || []).length >= 4);
  assert.match(server, /item\.openSockets > 0 && item\.expiresAt >= now\) touchGrant\(item\)/);

  // Behaviour of the extracted function.
  const source = /function touchGrant\(grant\) \{[\s\S]*?\n\}/.exec(server)[0];
  const touchGrant = new Function("VIEWER_IDLE_MS", `${source}; return touchGrant;`)(5 * 60_000);
  const now = Date.now();
  const grant = { expiresAt: now + 1_000, hardExpiresAt: now + 30 * 60_000, idleMs: 5 * 60_000 };
  touchGrant(grant);
  assert.ok(grant.expiresAt >= now + 5 * 60_000 - 50 && grant.expiresAt <= now + 5 * 60_000 + 1_000);
  const capped = { expiresAt: now + 1_000, hardExpiresAt: now + 2_000, idleMs: 5 * 60_000 };
  touchGrant(capped);
  assert.equal(capped.expiresAt, now + 2_000, "never past the hard cap");
  const longer = { expiresAt: now + 10 * 60_000, hardExpiresAt: now + 30 * 60_000, idleMs: 5 * 60_000 };
  touchGrant(longer);
  assert.equal(longer.expiresAt, now + 10 * 60_000, "never shortens a grant");
});

test("viewer reconnects dropped streams and recovers stalled ones without the user", () => {
  assert.match(viewer, /const RECONNECT_DELAYS_MS = \[400, 1500, 4000\];/);
  assert.match(viewer, /if \(everConnected\) scheduleReconnect\(\);/);
  assert.match(viewer, /window\.WebSocket = class TrackedWebSocket extends NativeWebSocket/);
  assert.match(viewer, /const STALL_MS = 5_000;/);
  assert.match(viewer, /lastStallReconnectAt = Date\.now\(\); reconnectNow\(\);/);
  assert.match(viewerHtml, /id="refresh"[^>]*hidden>The secure browser isn't responding\. Tap to refresh\.</);
  // Reconnecting never touches the remote page state, and never after landing.
  assert.match(viewer, /function reconnectNow\(escape = false\) \{\n  if \(landed \|\| finished \|\| surface !== "pixels"\) return;/);
});

test("landing keeps the events stream open and the server reports how the session ended", () => {
  const events = server.slice(server.indexOf("function serveViewerEvents"), server.indexOf("async function serveViewer("));
  assert.match(events, /res\.write\("event: landed\\ndata: \{\}\\n\\n"\);\n        return;/);
  assert.doesNotMatch(events, /event: landed\\ndata: \{\}\\n\\n"\); return stop\(\)/);
  assert.match(events, /if \(session\.landedAt && !session\.devRecording\) res\.write\("event: landed/);
  assert.match(server, /socket\.end\(`event: closed\\ndata: \$\{JSON\.stringify\(\{ reason: closeReason \}\)\}\\n\\n`\)/);
  assert.match(server, /revokeSessionLive\(session\.id, value\.reason === "signed-in" \? "signed-in" : "ended"\)/);
  assert.match(server, /removeBrowser\(session, value\.reason === "signed-in" \? "signed-in" : "ended"\)/);
  assert.match(server, /await removeBrowser\(session, "blocked"\);/);
  assert.match(completion, /relinquishInteractive\(providerSessionRef, \{ reason: "signed-in" \}\)/);
  assert.match(completion, /terminate\(providerSessionRef, \{ reason: "signed-in" \}\)/);
  assert.match(provider, /revoke-live`, options\?\.reason \? \{ reason: options\.reason \} : undefined\)/);
  // Viewer: success on "signed-in", actionable error otherwise; Canvas never shown.
  assert.match(viewer, /events\.addEventListener\("closed", onClosed\);/);
  assert.match(viewer, /if \(reason === "signed-in"\) return onSignedIn\(\);/);
  assert.match(viewer, /show\("signed-in", "Signed in ✓/);
  const stuck = Number(/const LANDED_STUCK_MS = ([\d_]+);/.exec(viewer)[1].replace(/_/g, ""));
  assert.ok(stuck <= 45_000, "parentless viewers surface an error within ~40 s");
});

test("popup finishes from the server's state within 30 s and never re-shows the remote page", () => {
  assert.match(popup, /export const FINISH_WINDOW_MS = 30_000;/);
  assert.doesNotMatch(popup, /type: "viewer-resume"/);
  assert.match(popup, /\/api\/canvas\/sessions\/\$\{sessionId\}\/confirm/);
  assert.match(popup, /if \(value\.session\.state === "active"\) \{ finishSignedIn\(\); return; \}/);
  assert.match(popup, /setErrorCode\("SIGN_IN_NOT_FINISHED"\)/);
  assert.match(popup, /message\.type === "signed-in-pending" \|\| message\.type === "signed-in"/);
  assert.match(popup, /"Signed in ✓"/);
  assert.doesNotMatch(popup, /unconfirmed/);
});

test("server-side completion: status() prefers the Canvas tab and monitors get their own slots", () => {
  assert.match(provider, /const page = allowed\.find\(\(candidate\) => \{ try \{ return new URL\(candidate\.url\(\)\)\.origin === handle\.canvasOrigin;/);
  assert.match(worker, /const MONITOR_CONCURRENCY = 2;/);
  assert.match(worker, /if \(monitors\.size < MONITOR_CONCURRENCY\) \{\n\s+const monitor = await claimAuthMonitor\(owner\.id\);/);
  assert.match(worker, /if \(active\.size >= concurrency\) continue;/);
  assert.match(worker, /await Promise\.allSettled\(\[\.\.\.active, \.\.\.monitors\]\)/);
});

test("dev recording mode is env-gated, default deny, and skips landed blanking", () => {
  assert.match(server, /const DEV_RECORDING_ALLOWED = process\.env\.BROWSER_DEV_RECORDING === "allow";/);
  assert.match(server, /devRecording: DEV_RECORDING_ALLOWED && devRecording === true/);
  assert.match(server, /if \(session\.devRecording\) return;/);
  assert.match(compose, /BROWSER_DEV_RECORDING: \$\{BROWSER_DEV_RECORDING:-deny\}/);
  assert.doesNotMatch(compose, /BROWSER_DEV_RECORDING:\s*\$\{BROWSER_DEV_RECORDING:-allow\}|BROWSER_DEV_RECORDING:\s*"?allow/);
});
