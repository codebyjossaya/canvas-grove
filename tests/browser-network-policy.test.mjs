import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress } from "../services/browser-network-policy.mjs";

test("canonical browser network policy rejects special and mapped addresses", () => {
  for (const address of ["0.0.0.1","10.1.2.3","100.64.0.1","127.0.0.1","169.254.169.254","172.16.0.1","192.0.0.1","192.0.2.1","192.168.1.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","240.0.0.1","::","::1","fc00::1","fd00::1","fe80::1","ff02::1","2001:db8::1","::ffff:127.0.0.1","::ffff:169.254.169.254"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1","8.8.8.8","2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});
