import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("only orchestrator owns Docker socket and it has no browser-egress attachment", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const orchestrator = compose.match(/  browser-orchestrator:[\s\S]*?\n  browser-relay:/)?.[0] ?? "";
  const relay = compose.match(/  browser-relay:[\s\S]*?\n  browser-egress-proxy:/)?.[0] ?? "";
  assert.match(orchestrator, /docker\.sock/);
  assert.match(orchestrator, /networks: \[backend, browser-control\]/);
  assert.doesNotMatch(orchestrator, /networks:.*browser-egress/);
  assert.match(relay, /networks: \[browser-control\]/);
  assert.doesNotMatch(relay, /docker\.sock/);
  assert.equal((compose.match(/docker\.sock/g) ?? []).length, 2); // host path + container path in one mount
  assert.match(compose, /browser-egress:[\s\S]*?internal: true/);
  assert.match(orchestrator, /canvas-browser-quarantine/);
});

test("orchestrator has no direct browser CDP or noVNC network calls", async () => {
  const source = await readFile(new URL("../services/browser-orchestrator/server.mjs", import.meta.url), "utf8");
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(source, /hostname:\s*session\.name/);
  assert.doesNotMatch(source, /session\.name[^\n]*(?:9222|6080)/);
  assert.match(source, /registerRelaySession/);
  assert.match(source, /relayRequest\("POST", `\/v1\/sessions\/\$\{session\.id\}\/capability`/);
  assert.match(source, /label=canvas\.browser\.network=true/);
  assert.match(source, /\^canvas-browser-net-\(\[0-9a-f-\]\{36\}\)\$/);
  assert.match(source, /protectedIds\.has/);
  assert.match(source, /new Set\(\[\.\.\.sessions\.keys\(\), \.\.\.\(lastOwnedSessionIds \?\? \[\]\)\]\)/);
  assert.match(source, /networkState\?\.Internal !== true/);
  assert.match(source, /networkState\?\.Labels\?\.\["canvas\.browser\.network"\] !== "true"/);
  assert.match(source, /attachedNames\.some\(\(name\) => !allowedNames\.has\(name\)\)/);
  assert.match(source, /error instanceof BrowserNetworkPolicyError/);
  assert.match(source, /browser_network_reconcile_deferred/);
  assert.match(compose, /BROWSER_PUBLIC_BASE_URL:\s*\$\{BROWSER_PUBLIC_BASE_URL:\?Set BROWSER_PUBLIC_BASE_URL to the exact external HTTPS origin\}/);
  assert.doesNotMatch(compose, /BROWSER_PUBLIC_BASE_URL:-http:/);
});

test("orchestrator image includes every local runtime module", async () => {
  const dockerfile = await readFile(new URL("../services/browser-orchestrator/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY package\.json server\.mjs orphan-policy\.mjs navigation-policy\.mjs/);
});

test("egress registrations stay exact; reviewed suffixes are built into the proxy image, not registrable", async () => {
  const proxy = await readFile(new URL("../services/browser-egress-proxy/server.mjs", import.meta.url), "utf8");
  const relay = await readFile(new URL("../services/browser-relay/server.mjs", import.meta.url), "utf8");
  assert.match(proxy, /const allowed=\(host,rules\)=>egressHostAllowed\(host,rules\)/);
  assert.match(proxy, /rules:new Set\(v\.hosts\.map\(norm\)\)/);
  assert.match(proxy, /v\.suffixes!==undefined/);
  assert.doesNotMatch(proxy, /endsWith\(`\.\$\{/);
  assert.doesNotMatch(relay, /reviewedVendorSuffixes|duosecurity\.com/);
});

test("relay uses the fixed proxy name visible on dynamic session networks", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /container_name:\s*canvas-browser-egress-proxy/);
  assert.match(compose, /BROWSER_EGRESS_PROXY_CONTROL_URL:\s*http:\/\/canvas-browser-egress-proxy:3128/);
  assert.doesNotMatch(compose, /BROWSER_EGRESS_PROXY_CONTROL_URL:\s*http:\/\/browser-egress-proxy:3128/);
});
