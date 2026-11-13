import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { envelopeDecryptBrowserState, envelopeEncryptBrowserState } from "../lib/bridge/providers/envelope";
import type { EncryptedBrowserState } from "../lib/bridge/hosted-browser";
import {
  CanvasResponseTooLargeError, CanvasSessionClient, cookiesForRequest, interpretResponse, isAuthFailure, MAX_RESPONSE_BYTES, mergeCookies, nextPathFromLink, parseSetCookie, readBounded, validateCanvasApiPath,
  type CanvasTransport, type EncryptedStateStore, type StoredBrowserState, type StoredCookie, type TransportRequest, type TransportResponse,
} from "../lib/canvas/session-client";
import { MAX_PAGES, pageAll } from "../lib/sync/executor";
import { releaseLoginBrowser } from "../lib/bridge/complete-authentication";

process.env.BROWSER_STATE_KEK ??= randomBytes(32).toString("base64");
const ORIGIN = "https://school.instructure.com";
const OWNER = "00000000-0000-4000-8000-000000000001";
const cookie = (name: string, value: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({ name, value, domain: "school.instructure.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax", ...extra });

function memoryStore(initial: StoredBrowserState) {
  let current = envelopeEncryptBrowserState(initial, OWNER);
  let writes = 0;
  const store: EncryptedStateStore & { jar(): StoredBrowserState; writes(): number; replace(next: StoredBrowserState): void } = {
    async load() { return { state: current, version: current.iv }; },
    async compareAndSwap(next: EncryptedBrowserState, expected: string) { if (current.iv !== expected) return false; current = next; writes += 1; return true; },
    jar: () => envelopeDecryptBrowserState(current, OWNER) as StoredBrowserState,
    writes: () => writes,
    replace(next) { current = envelopeEncryptBrowserState(next, OWNER); },
  };
  return store;
}

function fakeTransport(handler: (request: TransportRequest) => Partial<TransportResponse> & { json?: unknown }) {
  const calls: TransportRequest[] = [];
  const transport: CanvasTransport = async (request) => {
    calls.push(request);
    const response = handler(request);
    const body = response.body ?? Buffer.from(response.json === undefined ? "" : JSON.stringify(response.json));
    return { status: response.status ?? 200, headers: { "content-type": "application/json; charset=utf-8", ...response.headers }, body };
  };
  return { transport, calls };
}

// ---------------------------------------------------------------- cookie jar

test("cookie selection sends only Canvas-host cookies and honours domain, path, secure and expiry", () => {
  const now = Date.now();
  const jar: StoredCookie[] = [
    cookie("_normandy_session", "s"),
    cookie("parent", "p", { domain: ".instructure.com" }),
    cookie("idp", "x", { domain: "login.microsoftonline.com" }),
    cookie("duo", "x", { domain: ".duosecurity.com" }),
    cookie("sibling", "x", { domain: "other.instructure.com" }),
    cookie("scoped", "x", { path: "/api/v1/courses" }),
    cookie("unrelated_path", "x", { path: "/files" }),
    cookie("prefix_trap", "x", { path: "/api/v" }),
    cookie("expired", "x", { expires: Math.floor(now / 1000) - 10 }),
    cookie("session_only", "x", { expires: -1 }),
  ];
  const names = cookiesForRequest(jar, new URL(`${ORIGIN}/api/v1/courses/1`), now).map((item) => item.name);
  assert.deepEqual(new Set(names), new Set(["_normandy_session", "parent", "scoped", "session_only"]));
  assert.equal(names[0], "scoped", "longer paths first");
  assert.deepEqual(cookiesForRequest([cookie("secure_only", "x", { secure: true })], new URL("http://school.instructure.com/api/v1/x"), now), []);
});

test("Set-Cookie parsing rejects foreign domains and handles path, Max-Age and deletion", () => {
  const url = new URL(`${ORIGIN}/api/v1/users/self`);
  assert.equal(parseSetCookie("evil=1; Domain=attacker.example", url), null);
  assert.equal(parseSetCookie("evil=1; Domain=com", url), null);
  const parent = parseSetCookie("log_session_id=abc; Domain=.instructure.com; Path=/; Secure; HttpOnly", url)!;
  assert.equal(parent.cookie.domain, ".instructure.com");
  const hostOnly = parseSetCookie("_normandy_session=new; path=/; secure; HttpOnly; SameSite=None", url)!;
  assert.deepEqual([hostOnly.cookie.domain, hostOnly.cookie.expires, hostOnly.cookie.sameSite, hostOnly.remove], ["school.instructure.com", -1, "None", false]);
  assert.equal(parseSetCookie("pseudonym_credentials=; Max-Age=0; Path=/", url)!.remove, true);
  assert.equal(parseSetCookie("x=1", url)!.cookie.path, "/api/v1/users");
  const merged = mergeCookies([cookie("_normandy_session", "old"), cookie("pseudonym_credentials", "r")], [hostOnly, parseSetCookie("pseudonym_credentials=; Max-Age=0; Path=/", url)!]);
  assert.deepEqual(merged.map((item) => `${item.name}=${item.value}`), ["_normandy_session=new"]);
});

// ---------------------------------------------------------------- request shaping

test("CSRF header only on mutations, from the URL-decoded _csrf_token cookie", async () => {
  const store = memoryStore({ cookies: [cookie("_normandy_session", "s"), cookie("_csrf_token", "a%2Bb%3D")] });
  const { transport, calls } = fakeTransport(() => ({ json: {} }));
  const client = new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store, transport });
  await client.request({ method: "GET", path: "/api/v1/users/self" });
  await client.request({ method: "PUT", path: "/api/v1/users/self/favorites/courses/1", body: { a: 1 } });
  assert.equal(calls[0].headers["x-csrf-token"], undefined);
  assert.equal(calls[1].headers["x-csrf-token"], "a+b=");
  assert.equal(calls[1].headers["content-type"], "application/json");
  for (const call of calls) {
    assert.match(call.headers["user-agent"], /CanvasGrove/);
    assert.equal(call.headers.accept, "application/json");
    assert.match(call.headers.cookie, /_normandy_session=s/);
    assert.equal(call.url.origin, ORIGIN);
  }
});

test("path validation allows only same-origin /api/v1 paths", () => {
  for (const bad of ["/login", "/api/v2/x", "//evil.example/api/v1/x", "/api/v1/../login", "/api/v1/%2e%2e/login", "/api/v1/a\\b", "/api/v1/a b", "https://evil.example/api/v1/x", "/api/v1/x#frag"]) {
    assert.throws(() => validateCanvasApiPath(bad), /not allowed/, bad);
  }
  assert.equal(validateCanvasApiPath("/api/v1/courses?include[]=term&per_page=100"), "/api/v1/courses?include[]=term&per_page=100");
});

// ---------------------------------------------------------------- auth + redirects

test("401, a redirect to login/SSO, or an HTML page is authRequired; nothing is followed", async () => {
  assert.equal(isAuthFailure(401, {}, ORIGIN), true);
  assert.equal(isAuthFailure(302, { location: "/login/saml" }, ORIGIN), true);
  assert.equal(isAuthFailure(302, { location: "https://idp.example.edu/sso" }, ORIGIN), true);
  assert.equal(isAuthFailure(200, { "content-type": "text/html" }, ORIGIN), true);
  assert.equal(isAuthFailure(200, { "content-type": "application/json" }, ORIGIN), false);
  assert.equal(isAuthFailure(403, { "content-type": "application/json" }, ORIGIN), false);
  const store = memoryStore({ cookies: [cookie("_normandy_session", "s")] });
  const { transport, calls } = fakeTransport(() => ({ status: 302, headers: { location: `${ORIGIN}/login/canvas` } }));
  const client = new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store, transport });
  const result = await client.request({ method: "GET", path: "/api/v1/users/self" });
  assert.deepEqual([result.ok, result.authRequired, calls.length], [false, true, 1]);
  assert.equal(client.stats().authRequired, 1);
});

test("the default transport is node:https with no redirect following and public-only DNS", () => {
  const source = readFileSync(new URL("../lib/canvas/session-client.ts", import.meta.url), "utf8");
  assert.match(source, /httpsRequest\(input\.url, \{[\s\S]*lookup: publicOnlyLookup/);
  assert.doesNotMatch(source, /\bfetch\(/, "global fetch would follow redirects");
  assert.doesNotMatch(source, /redirect:\s*"follow"/);
  assert.match(source, /isPublicAddress\(address\)/);
});

// ---------------------------------------------------------------- rotation persistence

test("Set-Cookie rotation is persisted (CAS) and survives a concurrent writer", async () => {
  const store = memoryStore({ cookies: [cookie("_normandy_session", "v1"), cookie("_csrf_token", "t1")], origins: [] });
  let turn = 0;
  const { transport } = fakeTransport(() => {
    turn += 1;
    if (turn === 1) {
      // Another writer (e.g. an app request) rotated the CSRF token meanwhile.
      store.replace({ cookies: [cookie("_normandy_session", "v1"), cookie("_csrf_token", "t2")], origins: [] });
    }
    return { json: { id: 1 }, headers: { "set-cookie": [`_normandy_session=v${turn + 1}; path=/; secure; HttpOnly`] } };
  });
  const client = new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store, transport });
  await client.request({ method: "GET", path: "/api/v1/users/self" });
  await client.request({ method: "GET", path: "/api/v1/users/self" });
  await client.flush();
  const jar = store.jar();
  assert.equal(jar.cookies.find((item) => item.name === "_normandy_session")?.value, "v3");
  assert.equal(jar.cookies.find((item) => item.name === "_csrf_token")?.value, "t2", "the other writer's rotation is kept");
  assert.ok(store.writes() >= 1);
  const stats = client.stats();
  assert.equal(stats.sessionCookieReissues, 2);
  assert.deepEqual(stats.rotatedNames, ["_normandy_session"]);
});

test("remember-me presence and use are detected by name only", async () => {
  const store = memoryStore({ cookies: [cookie("pseudonym_credentials", "r")] });
  const { transport } = fakeTransport(() => ({ json: {}, headers: { "set-cookie": ["_normandy_session=fresh; path=/; secure"] } }));
  const client = new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store, transport });
  await client.request({ method: "GET", path: "/api/v1/users/self" });
  const stats = client.stats();
  assert.equal(stats.rememberCookiePresent, true);
  assert.equal(stats.rememberCookieUsed, true, "a session cookie issued while none was sent implies remember-me re-auth");
});

// ---------------------------------------------------------------- bounded responses + pagination

test("response bodies are bounded per response and per client", async () => {
  await assert.rejects(readBounded(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000), /larger than the sync limit/);
  assert.equal((await readBounded(Readable.from([Buffer.alloc(400), Buffer.alloc(600)]), 1000)).length, 1000);
  assert.equal(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
  const store = memoryStore({ cookies: [cookie("_normandy_session", "s")] });
  // Like httpsTransport: a body larger than the granted maxBytes is rejected.
  const { transport, calls } = fakeTransport((request) => { if (700 > request.maxBytes) throw new CanvasResponseTooLargeError(); return { body: Buffer.alloc(700, 0x20) }; });
  const client = new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store, transport, maxResponseBytes: 1000, maxTotalBytes: 1500 });
  await client.request({ method: "GET", path: "/api/v1/a" });
  await client.request({ method: "GET", path: "/api/v1/b" });
  assert.equal(calls[1].maxBytes, 800, "the remaining client budget caps the next response");
  await assert.rejects(client.request({ method: "GET", path: "/api/v1/c" }), /larger than the sync limit/);
});

test("pagination follows validated Link rel=next with a bounded page size and page count", async () => {
  assert.equal(nextPathFromLink(`<${ORIGIN}/api/v1/courses?page=2&per_page=100>; rel="next", <${ORIGIN}/api/v1/courses?page=9>; rel="last"`, ORIGIN), "/api/v1/courses?page=2&per_page=100");
  assert.equal(nextPathFromLink(`<https://evil.example/api/v1/courses?page=2>; rel="next"`, ORIGIN), undefined);
  assert.equal(nextPathFromLink(`<${ORIGIN}/login?page=2>; rel="next"`, ORIGIN), undefined);
  const paths: string[] = [];
  const result = await pageAll({ request: async (request) => {
    paths.push(request.path);
    const page = paths.length;
    return { ok: true, status: 200, authRequired: false, data: [{ id: page }], hasLinkHeader: true, nextPath: page < 3 ? `/api/v1/courses?page=${page + 1}&per_page=100` : undefined };
  } }, "/api/v1/courses");
  assert.deepEqual(paths, ["/api/v1/courses?per_page=100", "/api/v1/courses?page=2&per_page=100", "/api/v1/courses?page=3&per_page=100"]);
  assert.equal(result.complete, true);
  let calls = 0;
  const endless = await pageAll({ request: async () => { calls += 1; return { ok: true, status: 200, authRequired: false, data: [{}], hasLinkHeader: true, nextPath: "/api/v1/courses?page=x" }; } }, "/api/v1/courses");
  assert.deepEqual([calls, endless.complete, endless.result.ok], [MAX_PAGES, false, false]);
});

test("interpretResponse keeps rate-limit headers and strips the JSON hijack prefix", () => {
  const result = interpretResponse({ status: 200, headers: { "content-type": "application/json", "x-rate-limit-remaining": "0", "retry-after": "7" }, body: Buffer.from('while(1);[{"id":1}]') }, ORIGIN);
  assert.deepEqual([result.ok, result.rateLimitRemaining, result.retryAfterSeconds, result.data], [true, 0, 7, [{ id: 1 }]]);
});

// ---------------------------------------------------------------- architecture

test("sync and app code no longer execute Canvas requests through the hosted browser", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const executor = read("../lib/sync/executor.ts"), worker = read("../scripts/sync-worker.ts"), hosted = read("../lib/bridge/hosted-browser.ts"), quizzes = read("../lib/quizzes/service.ts");
  for (const [name, source] of [["executor", executor], ["worker", worker], ["hosted-browser", hosted], ["quizzes", quizzes]] as const) {
    assert.doesNotMatch(source, /(hostedBrowserProvider|provider)\.execute\(/, name);
    assert.doesNotMatch(source, /restoreMissingSyncRuntime|ensureHostedRuntime|executeWithHostedRuntimeRecovery/, name);
  }
  assert.doesNotMatch(hosted.slice(hosted.indexOf("export interface HostedBrowserProvider"), hosted.indexOf("export interface HostedSessionStore")), /\bexecute\(/);
  for (const provider of ["self-hosted", "browserbase", "dev"]) assert.doesNotMatch(read(`../lib/bridge/providers/${provider}.ts`), /async execute\(/, provider);
  assert.match(worker, /executeCanvasSyncJob\(\{ kind: job\.kind, api: client, /);
  assert.doesNotMatch(worker, /status in \('provisioning','auth_required','active','failed'\)/, "active sessions no longer protect a sync browser");
});

test("auth completion terminates the login browser in every completion path", async () => {
  const calls: string[] = [];
  const provider = { relinquishInteractive: async (ref: string) => { calls.push(`relinquish:${ref}`); }, terminate: async (ref: string) => { calls.push(`terminate:${ref}`); } };
  assert.equal(await releaseLoginBrowser(provider, "ref-1"), true);
  assert.deepEqual(calls, ["relinquish:ref-1", "terminate:ref-1"]);
  const gone = { relinquishInteractive: async () => { throw new Error("gone"); }, terminate: async () => { throw Object.assign(new Error("missing"), { code: "BROWSER_SESSION_NOT_FOUND" }); } };
  assert.equal(await releaseLoginBrowser(gone, "ref-2"), true, "an already-missing browser counts as released");
  const failing = { relinquishInteractive: async () => undefined, terminate: async () => { throw Object.assign(new Error("offline"), { code: "BROWSER_HOST_OFFLINE" }); } };
  assert.equal(await releaseLoginBrowser(failing, "ref-3"), false);
  const worker = readFileSync(new URL("../scripts/sync-worker.ts", import.meta.url), "utf8");
  const confirm = readFileSync(new URL("../app/api/canvas/sessions/[sessionId]/confirm/route.ts", import.meta.url), "utf8");
  assert.equal(worker.match(/completeAuthentication\([^)]*\)\)[^\n]*\n?[^\n]*releaseLoginBrowser\(hostedBrowserProvider/g)?.length, 2, "monitor + deadline paths");
  assert.match(confirm, /if \(won\) after\(\(\) => releaseLoginBrowser\(hostedBrowserProvider, providerSessionId\)/);
  assert.doesNotMatch(worker, /relinquishInteractive\(/);
});
