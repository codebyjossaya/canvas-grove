import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { envelopeDecryptBrowserState, envelopeEncryptBrowserState } from "../lib/bridge/providers/envelope";

test("encrypted browser state round-trips cookies and same-origin storage", () => {
  const prior = process.env.BROWSER_STATE_KEK;
  process.env.BROWSER_STATE_KEK = randomBytes(32).toString("base64");
  try {
    const state = {
      cookies: [{ name: "canvas_session", value: "opaque", domain: "school.instructure.com", path: "/" }],
      origins: [{ origin: "https://school.instructure.com", localStorage: [{ name: "feature", value: "on" }] }],
    };
    const encrypted = envelopeEncryptBrowserState(state, "owner-a");
    assert.deepEqual(envelopeDecryptBrowserState(encrypted, "owner-a"), state);
    assert.throws(() => envelopeDecryptBrowserState(encrypted, "owner-b"));
    assert.equal(JSON.stringify(encrypted).includes("canvas_session"), false);
  } finally {
    if (prior === undefined) delete process.env.BROWSER_STATE_KEK;
    else process.env.BROWSER_STATE_KEK = prior;
  }
});
