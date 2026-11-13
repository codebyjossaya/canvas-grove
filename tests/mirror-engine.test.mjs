// Unit tests for the DOM-mirror engine (services/browser-orchestrator/mirror/engine.mjs)
// with a stubbed CDP: cross-origin iframe contents never reach a viewer, landed
// Canvas pages are never mirrored, and secret (password / one-time-code) edits
// never echo a value back. No browser, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { MirrorEngine } from "../services/browser-orchestrator/mirror/engine.mjs";

const SESSION = "00000000-0000-4000-8000-000000000000";
const IDP = "https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO";
const LANDED = "https://ufl.instructure.com/courses";

function setup() {
  const engine = new MirrorEngine({
    sessionId: SESSION,
    connectUrl: async () => { throw new Error("no CDP in unit tests"); },
    resourceHostAllowed: () => true,
    mirrorable: (url) => /^https:\/\/(?:login\.ufl\.edu|ufl\.instructure\.com)\//.test(url) && !url.startsWith(LANDED),
    landed: (url) => url.startsWith(LANDED),
  });
  const out = [], calls = [];
  engine.subscribers.add({ mode: "mirror", send: (message) => out.push(message) });
  engine.cdp = { closed: false };
  engine.send = async (method, params) => { calls.push([method, params]); return engine.reply?.(method, params) ?? {}; };
  engine.targets.set("T", { sessionId: "S", url: IDP, attachedAt: 1 });
  engine.sessions.set("S", { targetId: "T", pageSessionId: "S", type: "page" });
  engine.sessions.set("X", { targetId: "TX", pageSessionId: "S", type: "iframe" });
  engine.activeTargetId = "T";
  // Child frames start without a key: the engine assigns one only when it mirrors the frame.
  const frame = (id, session, parent, url, contextId) => {
    const item = engine.registerFrame(id, session, "S", parent, url);
    Object.assign(item, { contextId, started: true });
    if (parent) item.owner = { f: 0, i: 99 }; else engine.frameKey(item);
    return item;
  };
  const main = frame("F0", "S", null, IDP, 1);
  engine.mainState = "live";
  return { engine, out, calls, main, frame };
}

const doc = (url, extra = {}) => ({ t: "doc", url, base: url, root: { i: 1, t: 1, n: "html", c: [{ i: 2, t: 1, n: "body", c: [{ i: 3, t: 3, x: "hello" }] }] }, ...extra });

test("same-origin child frames are mirrored; cross-origin iframe contents never are", async () => {
  const { engine, out, frame } = setup();
  const same = frame("F1", "S", "F0", "https://login.ufl.edu/idp/frame", 2);
  const blank = frame("F2", "S", "F0", "about:blank", 3);
  const duo = frame("F3", "X", "F0", "https://api-123.duosecurity.com/frame/web/v1/auth", 4);
  const nested = frame("F4", "X", "F3", "about:blank", 5);
  const back = frame("F5", "X", "F3", "https://login.ufl.edu/idp/again", 6);
  await engine.onCapture(same, doc(same.url), 100);
  await engine.onCapture(blank, doc("about:blank"), 100);
  assert.deepEqual(out.filter((m) => m.t === "doc").map((m) => m.f), [same.key, blank.key]);
  out.length = 0;
  for (const child of [duo, nested, back]) {
    await engine.onCapture(child, doc(child.url), 100);
    await engine.onCapture(child, { t: "mut", rems: [], adds: [{ p: 2, node: { i: 9, t: 3, x: "secret" } }], attrs: [], texts: [] }, 100);
    await engine.onCapture(child, { t: "val", i: 7, v: "123456" }, 10);
    await engine.onCapture(child, { t: "css", i: 8, css: "a{}" }, 10);
  }
  assert.deepEqual(out, [], "nothing from a cross-origin frame (or its descendants) is broadcast");
});

test("a landed Canvas document is never mirrored, even if it reports itself before navigation events", async () => {
  const { engine, out, main } = setup();
  await engine.onCapture(main, doc(LANDED), 100);
  assert.deepEqual(out, [{ t: "blank", g: engine.gen, landed: 1 }]);
  assert.equal(engine.mainState, "blank");
  out.length = 0;
  await engine.onCapture(main, { t: "mut", rems: [], adds: [{ p: 2, node: { i: 9, t: 3, x: "grades" } }], attrs: [], texts: [] }, 100);
  assert.deepEqual(out, [], "no mutations after blanking");
});

test("same-document navigation to a landed URL blanks the mirror", async () => {
  const { engine, out, main, calls } = setup();
  const before = engine.gen;
  await engine.onEvent("Page.navigatedWithinDocument", { frameId: "F0", url: `${LANDED}/1` }, "S");
  assert.equal(engine.gen, before + 1);
  assert.deepEqual(out, [{ t: "blank", g: engine.gen, landed: 1 }]);
  assert.equal(main.url, `${LANDED}/1`);
  assert.ok(calls.some(([method, params]) => method === "Runtime.evaluate" && /__cgm\.stop\(\)/.test(params.expression)), "capture stopped");
  await engine.onCapture(main, doc(IDP), 100);
  assert.equal(out.filter((m) => m.t === "doc").length, 0, "a stale capture cannot un-blank it");
  // A non-landed, non-mirrorable page is blank without the landed hint.
  const other = setup();
  await other.engine.onEvent("Page.navigatedWithinDocument", { frameId: "F0", url: "https://evil.example/" }, "S");
  assert.deepEqual(other.out, [{ t: "blank", g: other.engine.gen }]);
});

test("secret field edits replace the whole value and never echo it back", async () => {
  const { engine, calls, main } = setup();
  let stateFn = null;
  engine.reply = (method, params) => {
    if (method === "Runtime.evaluate") return { result: { objectId: "obj", subtype: "node" } };
    if (method === "Runtime.callFunctionOn" && /localName/.test(params.functionDeclaration) && !stateFn) {
      stateFn = params.functionDeclaration;
      // eslint-disable-next-line no-new-func
      const state = new Function(`return (${stateFn})`)().call({
        localName: "input", type: "text", id: "", value: "123", readOnly: false, disabled: false,
        getAttribute: (name) => (name === "autocomplete" ? "one-time-code" : null),
      });
      return { result: { value: state } };
    }
    return {};
  };
  const result = await engine.input({ t: "input", g: engine.gen, f: main.key, i: 5, v: "123456" });
  assert.ok(stateFn, "the remote state function ran");
  assert.deepEqual(result, { ok: true }, "no value in the response");
  assert.ok(calls.some(([method, params]) => method === "Runtime.callFunctionOn" && params.arguments?.[2]?.value === true), "whole value selected");
  assert.ok(calls.some(([method, params]) => method === "Input.insertText" && params.text === "123456"));
  // The same function reports ordinary fields with their value.
  const plain = new Function(`return (${stateFn})`)().call({ localName: "input", type: "email", id: "user", value: "fake@example.edu", getAttribute: () => null });
  assert.equal(plain.secret, false);
  assert.equal(plain.value, "fake@example.edu");
  const password = new Function(`return (${stateFn})`)().call({ localName: "input", type: "password", id: "", value: "x", getAttribute: () => null });
  assert.equal(password.secret, true);
  assert.equal(password.value, null);
});

test("a cross-origin frame never gets a frame key, so viewer input cannot address it", async () => {
  const { engine, frame } = setup();
  const duo = frame("F3", "X", "F0", "https://api-123.duosecurity.com/frame/web/v1/auth", 4);
  await engine.onCapture(duo, doc(duo.url), 100);
  assert.equal(duo.key, null);
  assert.ok(![...engine.keyToFrame.values()].includes("F3"));
  for (const f of [1, 2, 3]) assert.deepEqual(await engine.input({ t: "click", g: engine.gen, f, i: 1, ox: 0.5, oy: 0.5 }), { ok: false, code: "STALE" });
});
