import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import { completeAuthenticationTx } from "../lib/bridge/complete-authentication";
import { syncPolicies } from "../lib/sync/catalog";

// A minimal in-memory model of the rows completeAuthenticationTx touches, with
// the same uniqueness rules as the schema (account upsert, policy upsert, job
// dedupe "on conflict do nothing", monitor row locked and moved to succeeded).
function fakeDatabase() {
  const state = { monitorStatus: "leased" as string, accounts: new Set<string>(), policies: new Set<string>(), jobs: new Set<string>(), sessionActive: false };
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("for update of s,m")) return Promise.resolve(["queued", "leased"].includes(state.monitorStatus) ? [{ id: "session" }] : []);
    if (query.includes("insert into canvas_accounts")) { state.accounts.add(`${values[0]}:${values[1]}:${values[3]}`); return Promise.resolve([{ id: "account-1" }]); }
    if (query.includes("insert into sync_policies")) { state.policies.add(`${values[1]}:${values[2]}`); return Promise.resolve([{ id: `policy-${values[2]}` }]); }
    if (query.includes("insert into sync_jobs")) { state.jobs.add(String(values[6])); return Promise.resolve([]); }
    if (query.includes("update hosted_browser_sessions set canvas_account_id")) { state.sessionActive = true; return Promise.resolve([]); }
    if (query.includes("update interactive_session_monitors set status='succeeded'")) { state.monitorStatus = "succeeded"; return Promise.resolve([]); }
    return Promise.resolve([]);
  }) as unknown as postgres.TransactionSql;
  (tx as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
  return { tx, state };
}

const monitor = { monitorId: "m1", attemptId: "a1", ownerId: "user_1", hostedSessionId: "s1", canvasOrigin: "https://school.instructure.com", institutionName: "Example" };
const encrypted = { ciphertext: "c", wrappedDataKey: "k", keyId: "1", algorithm: "AES-256-GCM" as const, iv: "iv", authTag: "t" };

test("confirming twice finalizes once: one account, one job per kind, monitor succeeded", async () => {
  const { tx, state } = fakeDatabase();
  assert.equal(await completeAuthenticationTx(tx, monitor, "canvas-user-7", encrypted), true);
  assert.equal(await completeAuthenticationTx(tx, monitor, "canvas-user-7", encrypted), false);
  assert.equal(state.accounts.size, 1);
  assert.equal(state.jobs.size, Object.keys(syncPolicies).length);
  assert.equal(state.monitorStatus, "succeeded");
  assert.equal(state.sessionActive, true);
});

test("the route losing the race to the monitor is a no-op", async () => {
  const { tx, state } = fakeDatabase();
  state.monitorStatus = "succeeded"; // the monitor already finalized
  assert.equal(await completeAuthenticationTx(tx, monitor, "canvas-user-7", encrypted), false);
  assert.equal(state.accounts.size, 0);
  assert.equal(state.jobs.size, 0);
});
