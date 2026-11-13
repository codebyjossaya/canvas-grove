// Regression: a CONNECT tunnel whose client side dies while the upstream is still
// piping data raised an unhandled EPIPE on the client socket and crashed the egress
// proxy (23 restarts in a day on the live stack). Each restart drops every
// in-memory registration, so in-flight sign-in browsers get 403 (stage "client")
// for CDN subresources and IdP pages such as login.microsoftonline.com render blank.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const proxy = readFileSync("services/browser-egress-proxy/server.mjs", "utf8");
const start = proxy.indexOf('server.on("connect"');
const handler = start < 0 ? "" : proxy.slice(start, proxy.indexOf("403 Forbidden", start));

test("egress proxy handles client socket errors before any await", () => {
  assert.ok(handler, "CONNECT handler not found");
  const guard = handler.indexOf('client.on("error"');
  assert.ok(guard > 0, "client socket has an error listener");
  assert.ok(guard < handler.indexOf("await"), "listener is attached before the first await");
});

test("egress proxy tears the upstream down when the client closes", () => {
  assert.match(handler, /client\.once\("close",\(\)=>upstream\.destroy\(\)\)/);
  assert.match(handler, /upstream\.on\("error",\(\)=>client\.destroy\(\)\)/);
});
