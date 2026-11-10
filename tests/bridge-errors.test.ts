import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, normalizeBridgeError } from "../lib/bridge/errors";
import { runSingleFlight } from "../lib/bridge/single-flight";
import { envelopeEncryptBrowserState } from "../lib/bridge/providers/envelope";

test("normalizes offline transport failures without leaking internals", () => {
  const error = normalizeBridgeError(new Error("fetch failed: ECONNREFUSED 172.18.0.4:8080"));
  assert.equal(error.code, "BROWSER_HOST_OFFLINE");
  assert.equal(error.status, 503);
  assert.doesNotMatch(error.message, /172\.18|ECONNREFUSED/);
});

test("normalizes capacity and auth expiry", () => {
  assert.equal(normalizeBridgeError(new Error("no available browser capacity")).code, "BROWSER_HOST_CAPACITY");
  assert.equal(normalizeBridgeError(new Error("auth expired upstream")).code, "BROWSER_AUTH_EXPIRED");
});

test("preserves deliberate public bridge errors", () => {
  const source = new BridgeError("BROWSER_NAVIGATION_BLOCKED", "The sign-in redirect was blocked for safety.", 400);
  assert.equal(normalizeBridgeError(source), source);
});

test("redacts Playwright and Docker implementation errors", () => {
  for (const raw of ["page.goto: net::ERR_ABORTED", "browserType.connectOverCDP failed", "docker socket denied"]) {
    const error = normalizeBridgeError(new Error(raw));
    assert.equal(error.code, "BROWSER_HOST_ERROR");
    assert.doesNotMatch(error.message, /goto|CDP|docker|socket/i);
  }
});

test("exposes actionable starting and hung states", () => {
  const starting = normalizeBridgeError(new Error("browser warm pool is still starting"));
  assert.equal(starting.code, "BROWSER_STARTING"); assert.equal(starting.status, 425);
  const hung = normalizeBridgeError(new Error("renderer is unavailable after probe failed"));
  assert.equal(hung.code, "BROWSER_UNRESPONSIVE"); assert.equal(hung.status, 503);
  assert.doesNotMatch(hung.message, /renderer|probe/i);
});

test("coalesces concurrent connect recovery", async () => {
  const flights = new Map<string, Promise<number>>(); let calls = 0;
  const results = await Promise.all(Array.from({ length: 7 }, () => runSingleFlight(flights, "owner:session", async () => {
    calls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return 42;
  })));
  assert.equal(calls, 1); assert.deepEqual(results, Array(7).fill(42));
});

test("browser snapshots are envelope-encrypted and owner-bound", () => {
  const previous = process.env.BROWSER_STATE_KEK;
  process.env.BROWSER_STATE_KEK = Buffer.alloc(32, 7).toString("base64");
  try {
    const state = { cookies: [{ name: "opaque-test", value: "never-plaintext" }] };
    const first = envelopeEncryptBrowserState(state, "owner-a");
    const second = envelopeEncryptBrowserState(state, "owner-b");
    assert.doesNotMatch(JSON.stringify(first), /never-plaintext|opaque-test/);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(first.algorithm, "AES-256-GCM");
    assert.equal(first.wrappedDataKey.split(".").length, 3);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_STATE_KEK; else process.env.BROWSER_STATE_KEK = previous;
  }
});
