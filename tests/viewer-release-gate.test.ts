import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Settings → Canvas connection. Sign-in runs in the user's own browser through the Grove extension;
// the card renders useCanvasSignIn state and never embeds or pops up a credential page itself.
const source = readFileSync("components/ui/canvas-session.tsx", "utf8");
const hook = readFileSync("lib/extension/use-canvas-signin.ts", "utf8");

test("the card never embeds or opens a credential page itself", () => {
  assert.doesNotMatch(source, /<iframe|embedded-viewer|window\.open\(/);
  assert.match(source, /useCanvasSignIn\(/);
  assert.match(source, /useExtension\(/);
});

test("the page no longer drives extension capture; the extension reports progress by itself", () => {
  assert.doesNotMatch(source + hook, /canvas-auth-(check|capture|open)/);
  assert.match(hook, /"signin-start"/);
});

test("connected is decided by the server, not by extension messages", () => {
  assert.match(hook, /\/api\/canvas\/sessions\/\$\{encodeURIComponent\(session\.id\)\}`/);
  assert.match(hook, /server\.state === "active"[\s\S]{0,80}phase: "connected"/);
});

test("one primary action with consent, plus disconnect and waiting-state recovery", () => {
  assert.match(source, /Sign in with Canvas/);
  assert.doesNotMatch(source, /Review browser sign-in/);
  assert.match(source, /type="checkbox"/);
  assert.match(source, /Reopen sign-in tab/);
  assert.match(source, /Not seeing the tab\?/);
  assert.match(source, /Disconnect Canvas/);
});
