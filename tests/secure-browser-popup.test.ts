import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const popup = readFileSync("components/ui/secure-browser-popup.tsx", "utf8");
const opener = readFileSync("components/ui/canvas-session.tsx", "utf8");
const route = readFileSync("app/secure-browser/[sessionId]/page.tsx", "utf8");

test("popup route is authenticated and never receives a signed viewer URL", () => {
  assert.match(route, /await auth\(\)/);
  assert.match(route, /redirect\("\/sign-in"\)/);
  assert.doesNotMatch(route, /viewerUrl|searchParams|\?url=/);
  assert.match(popup, /\/api\/canvas\/sessions\/\$\{sessionId\}\/connect/);
});

test("opener and popup validate same-origin message sources", () => {
  assert.match(opener, /event\.origin !== window\.location\.origin \|\|\s*event\.source !== popup\.current/);
  assert.match(popup, /event\.origin !== window\.location\.origin \|\| event\.source !== iframe\.current\?\.contentWindow/);
  assert.match(popup, /window\.opener\.postMessage\([\s\S]*window\.location\.origin/);
});

test("ending a session removes the viewer and automatic completion closes it", () => {
  assert.match(popup, /setViewerUrl\(""\)/);
  assert.match(popup, /notify\("completed"\)/);
  assert.match(popup, /window\.setTimeout\(\(\) => window\.close\(\)/);
  assert.match(opener, /closePopup\(\)/);
  assert.doesNotMatch(popup, /beforeunload/, "normal placeholder-to-session navigation must not be reported as a closed window");
});

test("blocked redirect contract displays hostname only with retry and close recovery", () => {
  assert.match(popup, /safeBlockedHostname\(value\.blockedHost\)/);
  assert.match(popup, /errorCode === "BROWSER_NAVIGATION_BLOCKED"/);
  assert.match(popup, /Blocked hostname/);
  assert.match(popup, /Retry secure sign-in/);
  assert.match(popup, /Close and return/);
  assert.match(popup, /role=\{stage === "error" \|\| interactiveTimedOut \? "alert"/);
  assert.match(opener, /safeBlockedHostname\(message\.blockedHost\)/);
  assert.doesNotMatch(popup, /SAMLRequest|SAMLResponse|RelayState/);
});

test("interactive sign-in timeout is deadline-based and cannot be reset by ordinary retry", () => {
  assert.match(opener, /interactiveAuthExpiresAt: string \| null/);
  assert.match(popup, /interactiveAuthExpiresAt: string \| null/);
  assert.match(opener, /shouldShowInteractiveAuthDeadline\(current\)/);
  assert.match(popup, /shouldShowInteractiveAuthDeadline\(session\)/);
  assert.match(opener, /INTERACTIVE_AUTH_TIMEOUT/);
  assert.match(popup, /INTERACTIVE_AUTH_TIMEOUT/);
  assert.match(opener, /\/auth-attempt/);
  assert.match(opener, /Start a new secure sign-in/);
  assert.match(opener, /if \(flight\.current\) return false/);
  assert.match(opener, /clientExpiredSessionId === session\.id/);
  assert.doesNotMatch(opener, /launchExisting[\s\S]{0,600}auth-attempt/);
  assert.match(popup, /Return to Canvas Grove/);
});

test("opener reserves the popup and creates a missing attempt before navigation", () => {
  assert.match(opener, /openPopup\("\/secure-browser"\)/);
  assert.match(opener, /if \(forceNewAttempt \|\| !session\.interactiveAuthExpiresAt\)/);
  assert.match(opener, /await api<[\s\S]*\/auth-attempt/);
  assert.match(opener, /await prepareAttemptAndConnect\(created\.session, target, op\)/);
  assert.match(opener, /if \(flight\.current\) return/);
  assert.match(popup, /if \(!status\.session\.interactiveAuthExpiresAt\)/);
  assert.match(popup, /Preparing secure browser/);
});
