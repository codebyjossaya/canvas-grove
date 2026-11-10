import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync("components/ui/canvas-session.tsx", "utf8");

test("secure viewer uses a dedicated named popup instead of an embedded side viewer", () => {
  assert.match(source, /window\.open\(/, "direct user action must open a dedicated popup");
  assert.match(source, /\.focus\(\)/, "an existing named popup must be reused and focused");
  assert.doesNotMatch(source, /<iframe|embedded-viewer/, "credential entry must not be embedded in the application page");
});

test("viewer lifecycle explicitly handles blocked and closed popups", () => {
  assert.match(source, /popup[\s\S]{0,80}(blocked|null)|blocked[\s\S]{0,80}popup/i);
  assert.match(source, /\.closed/);
  assert.match(source, /Cancel &amp; revoke session|Disconnect &amp; delete session/);
});

test("viewer retains automatic completion detection and actionable failures", () => {
  assert.match(source, /startPolling/);
  assert.match(source, /BROWSER_(?:HOST_OFFLINE|UNRESPONSIVE|STARTING|AUTH_EXPIRED)/);
});
