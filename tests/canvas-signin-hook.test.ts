import assert from "node:assert/strict";
import test from "node:test";
import { CanvasSignInController, MAX_ATTEMPT_MS, SERVER_POLL_MS, type ServerCanvasSession, type SignInDeps } from "@/lib/extension/use-canvas-signin";
import type { ExtensionEvent, SigninStatus } from "@/lib/extension/web-bridge";

const ORIGIN = "https://school.instructure.com";
const SID = "11111111-1111-4111-8111-111111111111";
const school = { name: "Example University", domain: "school.instructure.com" };

function session(state: ServerCanvasSession["state"], extra: Partial<ServerCanvasSession> = {}): ServerCanvasSession {
  return { id: SID, canvasOrigin: ORIGIN, institutionName: school.name, state, updatedAt: new Date(0).toISOString(), interactiveAuthExpiresAt: null, ...extra };
}

type Route = (init: RequestInit | undefined, url: string) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

function harness(opts: { routes?: Record<string, Route>; ext?: Partial<Record<string, (payload: Record<string, unknown>) => unknown>> } = {}) {
  let clock = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls: string[] = [];
  const extCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let listener: ((event: ExtensionEvent) => void) | null = null;
  const routes: Record<string, Route> = {
    "GET /api/canvas/sessions": () => ({ body: { sessions: [] } }),
    "POST /api/canvas/sessions": () => ({ status: 201, body: { session: session("provisioning") } }),
    [`POST /api/canvas/sessions/${SID}/auth-attempt`]: () => ({ body: { session: session("provisioning", { interactiveAuthExpiresAt: new Date(clock + 600_000).toISOString() }) } }),
    [`GET /api/canvas/sessions/${SID}`]: () => ({ body: { session: session("provisioning") } }),
    [`DELETE /api/canvas/sessions/${SID}`]: () => ({ body: { revoked: true } }),
    ...opts.routes,
  };
  const ext: Record<string, (payload: Record<string, unknown>) => unknown> = {
    "signin-status": () => null,
    "signin-start": () => ({ ok: true }),
    "signin-focus": () => ({ ok: true }),
    "signin-cancel": () => ({ ok: true }),
    ...opts.ext,
  };
  const deps: SignInDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const route = routes[key];
      if (!route) throw new Error(`unexpected ${key}`);
      const { status = 200, body } = await route(init, url);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    extRequest: async <T,>(type: string, payload: Record<string, unknown>) => {
      extCalls.push({ type, payload });
      const handler = ext[type];
      if (!handler) throw new Error(`unexpected ext ${type}`);
      return handler(payload) as T;
    },
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    now: () => clock,
  };
  const controller = new CanvasSignInController(deps);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    controller, calls, extCalls, routes,
    get timers() { return timers; },
    emit(status: Partial<SigninStatus>) { listener?.({ type: "signin", status: { sessionId: SID, canvasOrigin: ORIGIN, at: clock, stage: "signing-in", ...status } as SigninStatus }); },
    async advance(ms: number) {
      clock += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= clock).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
        await settle(); await settle();
      }
      await settle();
    },
    settle,
    get snap() { return controller.getSnapshot(); },
  };
}

test("start creates the session and an attempt, then asks the extension to open the tab", async () => {
  const h = harness();
  await h.controller.attach();
  assert.equal(h.snap.loading, false);
  assert.equal(h.snap.existing, null);
  await h.controller.start(school);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("POST")), ["POST /api/canvas/sessions", `POST /api/canvas/sessions/${SID}/auth-attempt`]);
  const start = h.extCalls.find((c) => c.type === "signin-start");
  assert.deepEqual(start?.payload, { sessionId: SID, canvasOrigin: ORIGIN, loginUrl: `${ORIGIN}/login`, schoolName: school.name });
  assert.equal(h.snap.phase, "awaiting-tab-click");
  assert.deepEqual(h.snap.session, { id: SID, canvasOrigin: ORIGIN });
});

test("extension events move the phase, but only the server can report connected", async () => {
  let serverState: ServerCanvasSession["state"] = "provisioning";
  const h = harness({ routes: { [`GET /api/canvas/sessions/${SID}`]: () => ({ body: { session: session(serverState) } }) } });
  await h.controller.attach();
  await h.controller.start(school);
  h.emit({ stage: "signing-in" });
  assert.equal(h.snap.phase, "signing-in");
  h.emit({ stage: "verifying", account: { id: "7", name: "Jane Doe" } });
  assert.equal(h.snap.phase, "verifying");
  assert.deepEqual(h.snap.account, { name: "Jane Doe" });
  h.emit({ stage: "captured", account: { id: "7", name: "Jane Doe" } });
  await h.advance(0);
  assert.equal(h.snap.phase, "verifying", "captured alone is not connected while the server still says provisioning");
  serverState = "active";
  await h.advance(SERVER_POLL_MS);
  assert.equal(h.snap.phase, "connected");
  assert.deepEqual(h.snap.existing, { connected: true, canvasOrigin: ORIGIN, id: SID, accountName: "Jane Doe" });
  const polls = h.timers.size;
  await h.advance(SERVER_POLL_MS * 3);
  assert.equal(h.timers.size, polls, "polling stops once connected");
});

test("a lost captured message is recovered by server polling", async () => {
  let polls = 0;
  const h = harness({ routes: { [`GET /api/canvas/sessions/${SID}`]: () => ({ body: { session: session(++polls >= 3 ? "active" : "provisioning") } }) } });
  await h.controller.attach();
  await h.controller.start(school);
  await h.advance(SERVER_POLL_MS);
  await h.advance(SERVER_POLL_MS);
  assert.notEqual(h.snap.phase, "connected");
  await h.advance(SERVER_POLL_MS);
  assert.equal(h.snap.phase, "connected");
});

test("events for another session are ignored; tab-closed keeps the attempt alive", async () => {
  const h = harness();
  await h.controller.attach();
  await h.controller.start(school);
  h.emit({ sessionId: "other", stage: "failed", reason: "expired" });
  assert.equal(h.snap.phase, "awaiting-tab-click");
  h.emit({ stage: "tab-closed" });
  assert.equal(h.snap.tabClosed, true);
  assert.notEqual(h.snap.phase, "error");
  h.controller.focusTab();
  assert.equal(h.snap.tabClosed, false);
  assert.equal(h.extCalls.at(-1)?.type, "signin-focus");
});

test("extension failure reasons become plain errors; retry reuses the pending session", async () => {
  const h = harness();
  await h.controller.attach();
  await h.controller.start(school);
  h.emit({ stage: "failed", reason: "permission-denied" });
  await h.advance(0);
  assert.equal(h.snap.phase, "error");
  assert.equal(h.snap.error?.title, "Canvas access was not allowed");
  assert.match(h.snap.error?.message ?? "", /Allow/);
  const before = h.calls.filter((c) => c === "POST /api/canvas/sessions").length;
  await h.controller.retry(null);
  assert.equal(h.calls.filter((c) => c === "POST /api/canvas/sessions").length, before, "no second session created");
  assert.equal(h.snap.phase, "awaiting-tab-click");
});

test("signin-start rejection and extension timeout surface as errors", async () => {
  const h = harness({ ext: { "signin-start": () => ({ ok: false, reason: "not-paired" }) } });
  await h.controller.attach();
  await h.controller.start(school);
  assert.equal(h.snap.phase, "error");
  assert.equal(h.snap.error?.title, "This browser is not connected to Grove");

  const { ExtensionTimeoutError } = await import("@/lib/extension/web-bridge");
  const t = harness({ ext: { "signin-start": () => { throw new ExtensionTimeoutError("signin-start"); } } });
  await t.controller.attach();
  await t.controller.start(school);
  assert.equal(t.snap.error?.code, "EXTENSION_TIMEOUT");
});

test("server-side expiry ends the attempt with an error", async () => {
  const h = harness({ routes: { [`GET /api/canvas/sessions/${SID}`]: () => ({ body: { session: session("auth-expired", { lastError: "INTERACTIVE_AUTH_TIMEOUT" }) } }) } });
  await h.controller.attach();
  await h.controller.start(school);
  await h.advance(SERVER_POLL_MS);
  assert.equal(h.snap.phase, "error");
  assert.equal(h.snap.error?.code, "INTERACTIVE_AUTH_TIMEOUT");
});

test("polling gives up after the attempt budget", async () => {
  const h = harness();
  await h.controller.attach();
  await h.controller.start(school);
  await h.advance(MAX_ATTEMPT_MS + SERVER_POLL_MS * 2);
  assert.equal(h.snap.phase, "error");
});

test("cancel tells the extension and revokes the pending session", async () => {
  const h = harness();
  await h.controller.attach();
  await h.controller.start(school);
  await h.controller.cancel();
  assert.equal(h.snap.phase, "idle");
  assert.equal(h.snap.session, null);
  assert.ok(h.extCalls.some((c) => c.type === "signin-cancel"));
  assert.ok(h.calls.includes(`DELETE /api/canvas/sessions/${SID}`));
  h.emit({ stage: "captured" });
  assert.equal(h.snap.phase, "idle", "late events for the cancelled session are ignored");
});

test("an already-connected owner is reported through `existing` without starting anything", async () => {
  const h = harness({
    routes: { "GET /api/canvas/sessions": () => ({ body: { sessions: [session("active")] } }) },
    ext: { "signin-status": () => ({ sessionId: SID, stage: "captured", canvasOrigin: ORIGIN, account: { id: "7", name: "Jane Doe" }, at: 1 }) },
  });
  await h.controller.attach();
  assert.equal(h.snap.phase, "idle");
  assert.deepEqual(h.snap.existing, { connected: true, canvasOrigin: ORIGIN, id: SID, accountName: "Jane Doe" });
  assert.equal(h.extCalls.filter((c) => c.type === "signin-start").length, 0);
});

test("load resumes an attempt the extension still has open", async () => {
  const h = harness({
    routes: { "GET /api/canvas/sessions": () => ({ body: { sessions: [session("provisioning")] } }) },
    ext: { "signin-status": () => ({ sessionId: SID, stage: "signing-in", canvasOrigin: ORIGIN, at: 1 }) },
  });
  await h.controller.attach();
  assert.equal(h.snap.phase, "signing-in");
  assert.deepEqual(h.snap.session, { id: SID, canvasOrigin: ORIGIN });
});

test("a stale pending session for another school is revoked before creating a new one", async () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const h = harness({
    routes: {
      "GET /api/canvas/sessions": () => ({ body: { sessions: [{ ...session("provisioning"), id: OTHER, canvasOrigin: "https://other.instructure.com" }] } }),
      [`DELETE /api/canvas/sessions/${OTHER}`]: () => ({ body: { revoked: true } }),
    },
  });
  await h.controller.attach();
  await h.controller.start(school);
  const order = h.calls.filter((c) => !c.startsWith("GET"));
  assert.deepEqual(order.slice(0, 2), [`DELETE /api/canvas/sessions/${OTHER}`, "POST /api/canvas/sessions"]);
  assert.equal(h.snap.session?.id, SID);
});

test("an invalid school address fails fast without network calls", async () => {
  const h = harness();
  await h.controller.attach();
  const before = h.calls.length;
  await h.controller.start({ name: "Nope", domain: "http://localhost" });
  assert.equal(h.snap.phase, "error");
  assert.equal(h.calls.length, before);
});
