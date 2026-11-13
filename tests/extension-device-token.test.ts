import assert from "node:assert/strict";
import test from "node:test";
import { cleanDeviceName, hashSecret, mintToken, parseToken, secretMatches } from "../lib/extension/device-token";

const OWNER = "33433ac1-355c-44ce-89e6-00d4b9dd2e89";

test("a minted token parses back to its owner, device and secret, and verifies", () => {
  const minted = mintToken(OWNER);
  const parsed = parseToken(minted.token);
  assert.ok(parsed);
  assert.equal(parsed.ownerId, OWNER);
  assert.equal(parsed.deviceId, minted.deviceId);
  assert.equal(secretMatches(parsed.secret, minted.secretHash), true);
  assert.equal(minted.secretHash, hashSecret(parsed.secret));
  assert.equal(minted.token.includes(minted.secretHash), false, "the stored hash must not appear in the token");
});

test("tokens are unique and the secret is high entropy", () => {
  const a = mintToken(OWNER), b = mintToken(OWNER);
  assert.notEqual(a.token, b.token);
  assert.equal(parseToken(a.token)!.secret.length, 43);
});

test("a wrong secret, a cleared hash or a malformed hash never verifies", () => {
  const minted = mintToken(OWNER);
  const other = mintToken(OWNER);
  assert.equal(secretMatches(parseToken(other.token)!.secret, minted.secretHash), false);
  assert.equal(secretMatches("x".repeat(43), null), false);
  assert.equal(secretMatches("x".repeat(43), "not-a-hash"), false);
});

test("malformed tokens are rejected without throwing", () => {
  const good = mintToken(OWNER).token;
  for (const bad of ["", null, undefined, "gfe1", `gfe2${good.slice(4)}`, good + "x", good.replace(OWNER, "not-a-uuid"), good.slice(0, -1), `${good}\n`, ` ${good}`]) {
    assert.equal(parseToken(bad as string), null, String(bad));
  }
});

test("device names are cleaned and bounded", () => {
  assert.equal(cleanDeviceName("  My   <b>Laptop</b> \n"), "My bLaptop/b");
  assert.equal(cleanDeviceName(""), "Browser");
  assert.equal(cleanDeviceName(42), "Browser");
  assert.equal(cleanDeviceName("x".repeat(200)).length, 60);
});
