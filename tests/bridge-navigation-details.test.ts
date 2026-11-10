import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, bridgeErrorBody } from "../lib/bridge/errors";

test("navigation block serializes a normalized hostname only", async () => {
  assert.deepEqual(bridgeErrorBody(new BridgeError("BROWSER_NAVIGATION_BLOCKED", "The sign-in redirect was blocked for safety.", 400, "elearning.ufl.edu")), { error: "The sign-in redirect was blocked for safety.", code: "BROWSER_NAVIGATION_BLOCKED", blockedHost: "elearning.ufl.edu" });
});

test("navigation block drops unsafe hostname detail", async () => {
  for (const unsafe of ["https://login.ufl.edu/path?SAML=secret", "user@login.ufl.edu", "127.0.0.1", "login.ufl.edu#token"]) {
    const value = bridgeErrorBody(new BridgeError("BROWSER_NAVIGATION_BLOCKED", "blocked", 400, unsafe)) as Record<string, unknown>;
    assert.equal(value.blockedHost, undefined);
  }
});
