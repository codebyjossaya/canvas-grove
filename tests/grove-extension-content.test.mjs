import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The content script is a classic script; run it in a VM with a stubbed window/document/chrome.
const SOURCE = readFileSync(new URL("../extension/src/content.js", import.meta.url), "utf8");
const GROVE = "https://grove.test";
const CANVAS = "https://school.instructure.com";
const STATE = { installed: true, protocol: 2, version: "0.4.0", paired: true, deviceName: "Laptop", canvasOrigin: CANVAS, hasCanvasAccess: true, signin: null };
// Objects built inside the VM have another realm's prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function load({ connection = { token: "t", canvasOrigin: CANVAS }, replies = { hello: STATE } } = {}) {
  const posted = [];
  const sent = [];
  const windowListeners = [];
  const runtimeListeners = [];
  const documentListeners = {};
  const opened = [];
  const window = {
    location: { origin: GROVE },
    addEventListener: (type, listener) => { if (type === "message") windowListeners.push(listener); },
    postMessage: (data, target) => { assert.equal(target, GROVE, "replies stay on the page's own origin"); posted.push(plain(data)); },
    open: (url) => { opened.push(url); },
  };
  const chrome = {
    runtime: {
      id: "ext",
      lastError: null,
      sendMessage: (message, callback) => {
        sent.push(plain(message));
        const reply = typeof replies[message.type] === "function" ? replies[message.type](message) : replies[message.type];
        setImmediate(() => callback?.(reply));
      },
      onMessage: { addListener: (listener) => { runtimeListeners.push(listener); } },
    },
    storage: { local: { get: async () => ({ connection }) }, onChanged: { addListener: () => undefined } },
  };
  class Element {
    constructor(href) { this.href = href; }
    closest() { return this.href ? this : null; }
  }
  const document = { readyState: "complete", addEventListener: (type, listener) => { (documentListeners[type] ??= []).push(listener); } };
  const context = vm.createContext({ window, document, chrome, Element, URL, setImmediate });
  const run = () => vm.runInContext(SOURCE, context);
  run();
  const fromPage = (data, { foreign = false } = {}) => {
    for (const listener of windowListeners) listener({ source: foreign ? {} : window, origin: foreign ? "https://evil.test" : GROVE, data });
  };
  const click = (href, extra = {}) => {
    const event = { type: "click", button: 0, target: new Element(href), defaultPrevented: false, shiftKey: false, prevented: false, ...extra };
    event.preventDefault = () => { event.prevented = true; };
    event.stopPropagation = () => undefined;
    for (const listener of documentListeners.click ?? []) listener(event);
    return event;
  };
  return { posted, sent, opened, fromPage, click, run, windowListeners, runtimeListeners };
}

test("the content script announces extension state on load", async () => {
  const page = load();
  await settle();
  assert.deepEqual(page.sent[0], { type: "hello" });
  assert.deepEqual(page.posted, [{ source: "grove-extension", type: "state", state: STATE }]);
});

test("requests are forwarded with only known fields and answered with the same requestId", async () => {
  const page = load({ replies: { hello: STATE, "signin-start": { ok: true } } });
  await settle();
  page.fromPage({ source: "grove-web", type: "signin-start", requestId: "r1", sessionId: "s", canvasOrigin: CANVAS, loginUrl: `${CANVAS}/login`, schoolName: "School", evil: "x" });
  page.fromPage({ source: "grove-web", type: "signin-status", requestId: "r2", payload: { sessionId: "s2" } });
  await settle();
  assert.deepEqual(page.sent.slice(1), [
    { type: "signin-start", sessionId: "s", canvasOrigin: CANVAS, loginUrl: `${CANVAS}/login`, schoolName: "School" },
    { type: "signin-status", sessionId: "s2" },
  ]);
  assert.deepEqual(page.posted.slice(1), [
    { source: "grove-extension", type: "reply", requestId: "r1", result: { ok: true } },
    { source: "grove-extension", type: "reply", requestId: "r2", result: { ok: false, reason: "unavailable" } },
  ]);
});

test("foreign windows, unknown types and requests without an id are ignored", async () => {
  const page = load();
  await settle();
  page.fromPage({ source: "grove-web", type: "hello", requestId: "r1" }, { foreign: true });
  page.fromPage({ source: "grove-web", type: "signin-continue", requestId: "r2", sessionId: "s" });
  page.fromPage({ source: "grove-web", type: "signin-start", sessionId: "s" });
  page.fromPage({ source: "someone-else", type: "hello", requestId: "r3" });
  await settle();
  assert.equal(page.sent.length, 1, "only the load-time hello reached the extension");
});

test("background events are relayed to the page as state and signin messages", async () => {
  const page = load();
  await settle();
  const status = { sessionId: "s", stage: "verifying", canvasOrigin: CANVAS, at: 1 };
  const [listener] = page.runtimeListeners;
  listener({ type: "grove-events", events: [{ type: "signin", status }, { type: "state", state: STATE }] }, { id: "ext" });
  listener({ type: "grove-events", events: [{ type: "signin", status }] }, { id: "ext", tab: { id: 1 } });
  assert.deepEqual(page.posted.slice(1), [
    { source: "grove-extension", type: "signin", status },
    { source: "grove-extension", type: "state", state: STATE },
  ]);
});

test("links to the connected Canvas site open through the extension; other links are untouched", async () => {
  const page = load();
  await settle();
  const canvas = page.click(`${CANVAS}/courses/1`);
  assert.equal(canvas.prevented, true);
  assert.deepEqual(page.sent.at(-1), { type: "open", url: `${CANVAS}/courses/1`, force: false });
  await settle();
  const other = page.click("https://example.com/");
  assert.equal(other.prevented, false);
});

test("injecting the script twice into the same page keeps one listener", async () => {
  const page = load();
  page.run();
  assert.equal(page.windowListeners.length, 1);
});

test("the v1 connect-page handshake still answers ping and pair", async () => {
  const page = load({ replies: { hello: STATE, pair: { ok: true } } });
  await settle();
  page.fromPage({ source: "grove-web", type: "ping" });
  page.fromPage({ source: "grove-web", type: "pair", token: "tok", deviceName: "Laptop" });
  await settle();
  assert.deepEqual(page.posted.slice(1).map((message) => message.type), ["present", "paired"]);
});
