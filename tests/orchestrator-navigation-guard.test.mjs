import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync("services/browser-relay/server.mjs", "utf8");
const proxy = readFileSync("services/browser-egress-proxy/server.mjs", "utf8");
const policy = readFileSync("services/browser-network-policy.mjs", "utf8");

test("navigation guard remains active after viewer handoff and revokes violating sessions", () => {
  assert.match(source, /setInterval\(\(\)=>\{[^\n]*void guard\(\)/);
  assert.match(source, /relay_navigation_blocked/);
  assert.match(source, /await deleteRelaySession\(session\)/);
  assert.match(source, /signedCallback\("\/v1\/internal\/navigation-blocked"/);
  assert.doesNotMatch(source, /relay_navigation_blocked[^\n]*(?:target\.url|rawUrl|query|fragment)/);
});

test("DNS validation covers private, link-local, CGNAT, documentation, multicast, and IPv6 ULA", () => {
  for (const marker of ["10.0.0.0","100.64.0.0","127.0.0.0","169.254.0.0","172.16.0.0","192.168.0.0","192.0.2.0","198.51.100.0","203.0.113.0","224.0.0.0","2001:db8:"]) assert.match(policy, new RegExp(marker.replaceAll(".", "\\.")));
  assert.match(proxy, /rows\.every\([^)]*isPublicAddress/);
  assert.match(source, /egress proxy[\s\S]*every CONNECT/);
  assert.match(policy, /\^::ffff:/);
});

test("relay closes Chromium UI tabs (chrome:/devtools:/view-source:) instead of killing the session, but still blocks other schemes", () => {
  assert.match(source, /BROWSER_UI_SCHEMES=new Set\(\["chrome:","devtools:","chrome-untrusted:","view-source:"\]\)/);
  assert.match(source, /BROWSER_UI_SCHEMES\.has\(parsed\.protocol\)[\s\S]{0,200}\/json\/close\/\$\{t\.id\}[\s\S]{0,200}continue;/);
  assert.match(source, /parsed\.protocol!=="https:"\)\{[\s\S]{0,200}block\(session,undefined,"disallowed-scheme"\)/);
});
