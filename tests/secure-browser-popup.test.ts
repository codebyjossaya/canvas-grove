import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The Settings card no longer opens this popup (Canvas sign-in runs through the Grove extension, see
// tests/canvas-signin-hook.test.ts). These checks cover the popup route itself.

const popup = readFileSync("components/ui/secure-browser-popup.tsx", "utf8");
const route = readFileSync("app/secure-browser/[sessionId]/page.tsx", "utf8");

test("popup route is authenticated and never receives a signed viewer URL", () => {
  assert.match(route, /await auth\(\)/);
  assert.match(route, /redirect\("\/sign-in"\)/);
  assert.doesNotMatch(route, /viewerUrl|searchParams|\?url=/);
  assert.match(popup, /\/api\/canvas\/sessions\/\$\{sessionId\}\/connect/);
});

test("popup validates same-origin message sources", () => {
  assert.match(popup, /event\.origin !== window\.location\.origin \|\| event\.source !== iframe\.current\?\.contentWindow/);
  assert.match(popup, /window\.opener\.postMessage\([\s\S]*window\.location\.origin/);
});

test("ending a session removes the viewer and automatic completion closes it", () => {
  assert.match(popup, /setViewerUrl\(""\)/);
  assert.match(popup, /notify\("completed"\)/);
  assert.match(popup, /window\.setTimeout\(closeOrReturn, 850\)/);
  assert.doesNotMatch(popup, /beforeunload/, "normal placeholder-to-session navigation must not be reported as a closed window");
});

test("blocked redirect contract displays hostname only with retry and close recovery", () => {
  assert.match(popup, /safeBlockedHostname\(value\.blockedHost\)/);
  assert.match(popup, /errorCode === "BROWSER_NAVIGATION_BLOCKED"/);
  assert.match(popup, /Blocked hostname/);
  assert.match(popup, /Retry secure sign-in/);
  assert.match(popup, /Close and return/);
  assert.match(popup, /role=\{stage === "error" \|\| interactiveTimedOut \? "alert"/);
  assert.doesNotMatch(popup, /SAMLRequest|SAMLResponse|RelayState/);
});

test("interactive sign-in timeout is deadline-based and cannot be reset by ordinary retry", () => {
  assert.match(popup, /interactiveAuthExpiresAt: string \| null/);
  assert.match(popup, /shouldShowInteractiveAuthDeadline\(session\)/);
  assert.match(popup, /INTERACTIVE_AUTH_TIMEOUT/);
  assert.match(popup, /Return to Canvas Grove/);
});

test("popup creates a missing attempt before navigation", () => {
  assert.match(popup, /if \(!status\.session\.interactiveAuthExpiresAt\)/);
  assert.match(popup, /Preparing secure browser/);
});
