import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../services/browser-orchestrator/server.mjs", import.meta.url), "utf8");
const viewer = readFileSync(new URL("../services/browser-orchestrator/viewer/viewer.js", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/canvas/sessions/[sessionId]/connect/route.ts", import.meta.url), "utf8");
const store = readFileSync(new URL("../lib/bridge/postgres-hosted-store.ts", import.meta.url), "utf8");

test("noVNC module assets are served by the orchestrator instead of container websockify", () => {
  assert.match(server, /NOVNC_ROOT/);
  assert.match(server, /readViewerAsset/);
  assert.match(server, /serveViewer/);
  assert.doesNotMatch(server, /function proxyViewer/);
  assert.doesNotMatch(server, /port: 6080, method: req\.method, path: upstreamPath/);
});

test("viewer shell emits honest readiness and failure messages", () => {
  // The chrome-free viewer emits readiness/disconnect; the orchestrator's failure page emits expiry.
  for (const signal of ["shell-ready", "ws-ready", "failed", "disconnected"]) assert.match(viewer, new RegExp(signal));
  assert.match(viewer, /window\.parent\.postMessage/);
  assert.match(server, /authorization-expired/);
  assert.match(server, /window\.parent\.postMessage/);
});

test("reconnect revokes stale tokens and sockets instead of returning a five-minute conflict", () => {
  assert.match(server, /revokeSessionLive\(session\.id\)/);
  assert.match(server, /socket\.destroy\(\)/);
  assert.doesNotMatch(route, /liveViewExpiresAt.*409/);
});

test("cancel wins provisioning races and cannot be resurrected by connect", () => {
  assert.match(route, /claimed\.state === "terminated"/);
  assert.match(route, /updated\.state === "terminated"/);
  assert.match(route, /terminate\(providerSessionId\)/);
  assert.match(store, /ne\(hostedBrowserSessions\.status, "revoked"\)/);
});

test("unowned managed browser containers are removed automatically after grace", () => {
  assert.doesNotMatch(server, /name\.startsWith\("canvas-browser-warm-"\).*continue/);
  assert.match(server, /Date\.now\(\) - createdAt < ORPHAN_GRACE_MS/);
  assert.match(server, /\["rm", "-f", name\]/);
});

test("websockify upgrade retries transient container refusals", () => {
  assert.match(server, /const attempt = \(number = 0\)/);
  assert.match(server, /Math\.min\(50 \* 2 \*\* number, 1000\)/);
  assert.match(server, /number >= 9/);
});
