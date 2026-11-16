import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, extHello, extRequest, ExtensionTimeoutError, reasonMessage, subscribeExtension, type ExtensionEvent } from "@/lib/extension/web-bridge";
import { statusFor } from "@/lib/extension/use-extension";

const ORIGIN = "https://grove.test";
type Posted = { data: Record<string, unknown>; target: string };
type Stub = {
  posted: Posted[];
  listeners: Set<(event: MessageEvent) => void>;
  onPost?: (data: Record<string, unknown>) => void;
  dispatch(data: unknown, opts?: { source?: unknown; origin?: string }): void;
};

function installWindow(): Stub {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: Posted[] = [];
  const stub = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: MessageEvent) => void) => { if (type === "message") listeners.add(fn); },
    removeEventListener: (type: string, fn: (event: MessageEvent) => void) => { listeners.delete(fn); },
    postMessage(data: Record<string, unknown>, target: string) { posted.push({ data, target }); queueMicrotask(() => stub.onPost?.(data)); },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    posted,
    listeners,
    onPost: undefined as Stub["onPost"],
    dispatch(data: unknown, opts: { source?: unknown; origin?: string } = {}) {
      for (const fn of [...listeners]) fn({ data, source: "source" in opts ? opts.source : stub, origin: opts.origin ?? ORIGIN } as unknown as MessageEvent);
    },
  };
  (globalThis as { window?: unknown }).window = stub;
  return stub;
}

const v2State = { installed: true, protocol: 2, version: "0.4.0", paired: true, deviceName: "Chrome on Mac", canvasOrigin: "https://school.instructure.com", hasCanvasAccess: false, signin: null };
const reply = (requestId: unknown, result: unknown) => ({ source: "grove-extension", type: "reply", requestId, result });

test("extRequest posts a same-origin envelope and resolves only on the matching reply", async () => {
  const w = installWindow();
  w.onPost = (data) => {
    // Foreign or malformed messages are ignored.
    w.dispatch(reply(data.requestId, { ok: "wrong-origin" }), { origin: "https://evil.test" });
    w.dispatch(reply(data.requestId, { ok: "wrong-window" }), { source: {} });
    w.dispatch({ ...reply(data.requestId, { ok: "wrong-source" }), source: "grove-web" });
    w.dispatch(reply("someone-else", { ok: "wrong-id" }));
    w.dispatch({ source: "grove-extension", type: "canvas-auth-result", requestId: data.requestId, result: { ok: "legacy-type" } });
    w.dispatch(reply(data.requestId, { ok: true }));
  };
  const result = await extRequest<{ ok: unknown }>("signin-focus", { sessionId: "s1" }, 500);
  assert.deepEqual(result, { ok: true });
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].target, ORIGIN);
  assert.equal(w.posted[0].data.source, "grove-web");
  assert.equal(w.posted[0].data.type, "signin-focus");
  assert.equal(w.posted[0].data.sessionId, "s1");
  assert.equal(typeof w.posted[0].data.requestId, "string");
  assert.equal(w.listeners.size, 0, "listener removed after reply");
});

test("payload cannot override the envelope fields", async () => {
  const w = installWindow();
  w.onPost = (data) => w.dispatch(reply(data.requestId, { ok: true }));
  await extRequest("pair", { source: "grove-extension", type: "reply", requestId: "forged", token: "t" }, 500);
  assert.equal(w.posted[0].data.source, "grove-web");
  assert.equal(w.posted[0].data.type, "pair");
  assert.notEqual(w.posted[0].data.requestId, "forged");
});

test("extRequest times out with ExtensionTimeoutError and cleans up", async () => {
  const w = installWindow();
  await assert.rejects(extRequest("signin-start", {}, 30), (error: unknown) => error instanceof ExtensionTimeoutError && error.requestType === "signin-start");
  assert.equal(w.listeners.size, 0);
});

test("extHello returns the v2 state, normalised", async () => {
  const w = installWindow();
  w.onPost = (data) => { if (data.type === "hello") w.dispatch(reply(data.requestId, { ...v2State, extra: "ignored", signin: { bogus: true } })); };
  const state = await extHello(300);
  assert.deepEqual(state, v2State);
  assert.equal(statusFor(state, "0.4.0"), "ready");
  assert.equal(w.listeners.size, 0);
});

test("an unsolicited v2 state event also answers hello", async () => {
  const w = installWindow();
  w.onPost = (data) => { if (data.type === "hello") w.dispatch({ source: "grove-extension", type: "state", state: { ...v2State, paired: false } }); };
  const state = await extHello(300);
  assert.equal(statusFor(state, "0.4.0"), "unpaired");
});

test("an old extension that answers only canvas-auth-state is reported as outdated", async () => {
  const w = installWindow();
  w.onPost = (data) => {
    if (data.type === "canvas-auth-state") w.dispatch({ source: "grove-extension", type: "canvas-auth-result", requestId: data.requestId, result: { installed: true, paired: true } });
  };
  const started = Date.now();
  const state = await extHello(5000);
  assert.ok(Date.now() - started < 2000, "does not wait for the full hello timeout");
  assert.deepEqual(state, { installed: true, protocol: 1, version: null, paired: true });
  assert.equal(statusFor(state, "0.4.0"), "outdated");
});

test("hello wins over the legacy probe when a v2 extension answers both", async () => {
  const w = installWindow();
  w.onPost = (data) => {
    if (data.type === "canvas-auth-state") w.dispatch({ source: "grove-extension", type: "canvas-auth-result", requestId: data.requestId, result: { installed: true, paired: true } });
    if (data.type === "hello") setTimeout(() => w.dispatch(reply(data.requestId, v2State)), 50);
  };
  assert.equal(statusFor(await extHello(1000), "0.4.0"), "ready");
});

test("no answer means missing; a protocol-2 extension below the minimum version is outdated", async () => {
  installWindow();
  assert.equal(await extHello(30), null);
  assert.equal(statusFor(null, "0.4.0"), "missing");
  assert.equal(statusFor({ ...v2State, version: "0.3.9" } as typeof v2State & { protocol: 2; installed: true }, "0.4.0"), "outdated");
  assert.equal(statusFor({ ...v2State, version: "0.10.0" } as typeof v2State & { protocol: 2; installed: true }, "0.4.0"), "ready");
});

test("subscribeExtension forwards only well-formed same-window events and unsubscribes", () => {
  const w = installWindow();
  const seen: ExtensionEvent[] = [];
  const off = subscribeExtension((event) => seen.push(event));
  const status = { sessionId: "s1", stage: "signing-in", canvasOrigin: "https://school.instructure.com", at: 1 };
  w.dispatch({ source: "grove-extension", type: "signin", status });
  w.dispatch({ source: "grove-extension", type: "signin", status: { ...status, stage: "made-up" } });
  w.dispatch({ source: "grove-extension", type: "signin", status }, { origin: "https://evil.test" });
  w.dispatch({ source: "grove-extension", type: "state", state: v2State });
  w.dispatch({ source: "grove-extension", type: "state", state: { installed: true, paired: true } });
  off();
  w.dispatch({ source: "grove-extension", type: "signin", status });
  assert.deepEqual(seen.map((event) => event.type), ["signin", "state"]);
  assert.equal(w.listeners.size, 0);
});

test("reasonMessage maps stable codes to plain copy", () => {
  assert.match(reasonMessage("permission-denied"), /Allow/);
  assert.match(reasonMessage("capture-rejected:CANVAS_SESSION_EXPIRED"), /expired/);
  assert.match(reasonMessage("capture-rejected:SOMETHING_NEW"), /could not verify/);
  assert.match(reasonMessage("expired"), /30 minutes/);
  for (const code of [undefined, "", "unheard-of"]) {
    const text = reasonMessage(code);
    assert.ok(text.length > 10);
    assert.doesNotMatch(text, /something went wrong/i);
  }
});

test("compareVersions is numeric", () => {
  assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.4.0"), 1);
  assert.equal(compareVersions("0.3.2", "0.4"), -1);
});
