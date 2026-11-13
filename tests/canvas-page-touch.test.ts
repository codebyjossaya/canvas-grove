import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { envelopeDecryptBrowserState, envelopeEncryptBrowserState } from "../lib/bridge/providers/envelope";
import type { EncryptedBrowserState } from "../lib/bridge/hosted-browser";
import { CanvasSessionClient, readCapped, TOUCH_BODY_CAP_BYTES, type CanvasTransport, type EncryptedStateStore, type StoredBrowserState, type TransportRequest, type TransportResponse } from "../lib/canvas/session-client";
import { nextKeepaliveKind, pageKeepaliveEnabled } from "../lib/canvas/session-health";

process.env.BROWSER_STATE_KEK ??= randomBytes(32).toString("base64");
const ORIGIN = "https://school.instructure.com";
const OWNER = "00000000-0000-4000-8000-000000000001";
const jar0: StoredBrowserState = { cookies: [{ name: "_normandy_session", value: "old", domain: "school.instructure.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" }] };

function store(initial: StoredBrowserState) {
  let current = envelopeEncryptBrowserState(initial, OWNER);
  const s: EncryptedStateStore & { jar(): StoredBrowserState } = {
    async load() { return { state: current, version: current.iv }; },
    async compareAndSwap(next: EncryptedBrowserState, expected: string) { if (current.iv !== expected) return false; current = next; return true; },
    jar: () => envelopeDecryptBrowserState(current, OWNER) as StoredBrowserState,
  };
  return s;
}
function setup(handler: (r: TransportRequest) => Partial<TransportResponse>) {
  const calls: TransportRequest[] = [];
  const transport: CanvasTransport = async (r) => { calls.push(r); const x = handler(r); return { status: x.status ?? 200, headers: { "content-type": "text/html", ...x.headers }, body: x.body ?? Buffer.from("<html></html>") }; };
  const s = store(jar0);
  return { calls, s, client: new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store: s, transport }) };
}

test("touchSession requests only GET / as HTML, with cookies and no redirect following", async () => {
  const { client, calls } = setup(() => ({ status: 302, headers: { location: "https://school.instructure.com/somewhere-else" } }));
  const result = await client.touchSession();
  assert.equal(calls.length, 1, "a redirect is never followed");
  assert.equal(calls[0].url.href, `${ORIGIN}/`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.accept, "text/html");
  assert.match(calls[0].headers.cookie, /^_normandy_session=old/);
  assert.equal(calls[0].maxBytes, TOUCH_BODY_CAP_BYTES);
  assert.equal(calls[0].truncate, true);
  assert.equal(result.status, 302);
  assert.equal(result.authRequired, false, "a non-login redirect is not an auth failure");
});

test("touchSession persists a re-issued session cookie and reports it", async () => {
  const { client, s } = setup(() => ({ headers: { "set-cookie": ["_normandy_session=new; Path=/; Secure; HttpOnly", "_csrf_token=t; Path=/"] } }));
  const result = await client.touchSession();
  await client.flush();
  assert.deepEqual({ status: result.status, sessionCookieReissued: result.sessionCookieReissued, rotatedNames: result.rotatedNames }, { status: 200, sessionCookieReissued: true, rotatedNames: ["_csrf_token", "_normandy_session"] });
  assert.equal(s.jar().cookies.find((c) => c.name === "_normandy_session")?.value, "new");
  assert.equal(client.stats().sessionCookieReissues, 1);
});

test("touchSession counts a re-issued canvas_session (newer Canvas naming) as a session re-issue", async () => {
  const { client } = setup(() => ({ headers: { "set-cookie": ["canvas_session=new; Path=/; Secure; HttpOnly", "log_session_id=x; Path=/"] } }));
  const result = await client.touchSession();
  assert.equal(result.sessionCookieReissued, true);
  assert.equal(client.stats().sessionCookieReissues, 1);
});

test("touchSession without Set-Cookie reports no re-issue", async () => {
  const { client } = setup(() => ({}));
  const result = await client.touchSession();
  assert.deepEqual({ r: result.sessionCookieReissued, n: result.rotatedNames, a: result.authRequired }, { r: false, n: [], a: false });
});

test("a 302 to /login or an SSO host means auth-required", async () => {
  for (const location of [`${ORIGIN}/login/canvas`, "https://idp.example.edu/sso", `${ORIGIN}/login`]) {
    const { client } = setup(() => ({ status: 302, headers: { location } }));
    const result = await client.touchSession();
    assert.equal(result.authRequired, true, location);
    assert.equal(client.stats().authRequired, 1);
  }
});

test("page body is capped: readCapped keeps at most the cap and stops reading", async () => {
  let pulled = 0;
  async function* chunks() { for (let i = 0; i < 100; i += 1) { pulled += 1; yield Buffer.alloc(10_000, 1); } }
  const body = await readCapped(chunks(), 25_000);
  assert.equal(body.length, 25_000);
  assert.ok(pulled <= 3, "stream abandoned after the cap");
  assert.equal((await readCapped(Readable.from([Buffer.alloc(5)]), 100)).length, 5);
});

test("keepalive alternates API and page kinds and can be disabled", () => {
  assert.equal(nextKeepaliveKind(null, true), "keepalive");
  assert.equal(nextKeepaliveKind("keepalive", true), "page-keepalive");
  assert.equal(nextKeepaliveKind("page-keepalive", true), "keepalive");
  assert.equal(nextKeepaliveKind("keepalive", false), "keepalive");
  assert.equal(pageKeepaliveEnabled(undefined), true);
  assert.equal(pageKeepaliveEnabled("1"), true);
  assert.equal(pageKeepaliveEnabled("0"), false);
});
