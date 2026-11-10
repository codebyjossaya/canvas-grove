import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("browser proxy defaults to the egress proxy container name, not the compose alias", async () => {
  const script = await read("browser/browser-image/start-browser.sh");
  const proxyArg = script.match(/--proxy-server="([^"]*)"/)?.[1] ?? "";
  assert.equal(proxyArg, "${BROWSER_EGRESS_PROXY:-http://canvas-browser-egress-proxy:3128}");
  // The compose alias only resolves on the uplink network, never on the per-session network.
  assert.doesNotMatch(script, /:-http:\/\/browser-egress-proxy:3128/);
});

test("orchestrator passes BROWSER_EGRESS_PROXY using the egress proxy container name", async () => {
  const source = await read("services/browser-orchestrator/server.mjs");
  assert.match(source, /EGRESS_PROXY_CONTAINER\s*=\s*"canvas-browser-egress-proxy"/);
  const launch = source.match(/async function launchBrowser\([\s\S]*?\n}\n/)?.[0] ?? "";
  assert.ok(launch, "launchBrowser not found");
  assert.match(launch, /"-e",\s*`BROWSER_EGRESS_PROXY=http:\/\/\$\{EGRESS_PROXY_CONTAINER\}:3128`/);
  assert.doesNotMatch(launch, /BROWSER_EGRESS_PROXY=http:\/\/browser-egress-proxy:3128/);
});

async function bootstrapInsert() {
  const worker = await read("scripts/sync-worker.ts");
  const fn = worker.match(/async function bootstrapAuthMonitors\([\s\S]*?\n}\n/)?.[0] ?? "";
  const insert = fn.match(/insert into interactive_session_monitors[\s\S]*?on conflict do nothing/)?.[0] ?? "";
  assert.ok(insert, "bootstrap monitor insert not found");
  return insert;
}

test("bootstrapAuthMonitors exclusion is NULL-safe for fresh login attempts", async () => {
  const insert = await bootstrapInsert();
  assert.match(insert, /not \(s\.status='auth_required' and coalesce\(s\.failure_code,''\) in \('BROWSER_SESSION_NOT_FOUND','AUTH_REQUIRED'\)\)/);
  // A bare `s.failure_code in (...)` inside `not (...)` evaluates to NULL for
  // failure_code IS NULL, which silently excludes every fresh login attempt.
  assert.doesNotMatch(insert, /(?<!coalesce\()s\.failure_code in \('BROWSER_SESSION_NOT_FOUND','AUTH_REQUIRED'\)/);
});

test("SQL three-valued logic: old exclusion drops NULL failure_code rows, new one keeps them", () => {
  // Minimal SQL 3VL model (null = UNKNOWN) of the WHERE-clause fragment.
  const and = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
  const not = (a) => (a === null ? null : !a);
  const inList = (v, list) => (v === null ? null : list.includes(v));
  const coalesce = (v, d) => (v === null ? d : v);
  const codes = ["BROWSER_SESSION_NOT_FOUND", "AUTH_REQUIRED"];
  const oldPredicate = (s) => not(and(s.status === "auth_required", inList(s.failure_code, codes)));
  const newPredicate = (s) => not(and(s.status === "auth_required", inList(coalesce(s.failure_code, ""), codes)));
  const rows = [
    { status: "auth_required", failure_code: null, expected: true },
    { status: "auth_required", failure_code: "BROWSER_SESSION_NOT_FOUND", expected: false },
    { status: "auth_required", failure_code: "AUTH_REQUIRED", expected: false },
    { status: "auth_required", failure_code: "BROWSER_PROBE_FAILED", expected: true },
    { status: "provisioning", failure_code: null, expected: true },
  ];
  assert.equal(oldPredicate(rows[0]), null, "old predicate is UNKNOWN (row excluded) for a fresh attempt");
  for (const row of rows) assert.equal(newPredicate(row) === true, row.expected, JSON.stringify(row));
});

test("stop-auth-required marks the session BROWSER_SESSION_NOT_FOUND to prevent monitor churn", async () => {
  const worker = await read("scripts/sync-worker.ts");
  const branch = worker.match(/if \(repairAction === "stop-auth-required"\) \{[\s\S]*?\n      return;\n    \}/)?.[0] ?? "";
  assert.ok(branch, "stop-auth-required branch not found");
  assert.match(branch, /update interactive_session_monitors set status='failed'/);
  assert.match(branch, /update hosted_browser_sessions set failure_code='BROWSER_SESSION_NOT_FOUND'/);
  assert.match(branch, /interactive_attempt_id=\$\{monitor\.attemptId\} and status='auth_required'/);
  // The session marker must be one of the codes the bootstrap exclusion skips.
  const insert = await bootstrapInsert();
  assert.match(insert, /'BROWSER_SESSION_NOT_FOUND'/);
});

test("egress proxy logs the denied hostname", async () => {
  const proxy = await read("services/browser-egress-proxy/server.mjs");
  const denied = proxy.match(/\{[^{}]*event:\s*"egress_connect_denied"[^;]*/)?.[0] ?? "";
  assert.ok(denied, "egress_connect_denied log not found");
  assert.match(denied, /\bhost:\s*deniedHost\b/);
});
