// Unit tests for the DOM-mirror protocol (services/browser-orchestrator/viewer/mirror-protocol.js):
// sanitizer vs an XSS corpus, URL rewriting, mutation sanitizing, input mapping and
// the fallback detector. Pure functions, no DOM.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_MESSAGES, MIRROR_LIMITS, MirrorLimitError, SECRET_FIELD_PATTERN, clickPoint, clientAttrAllowed, clientCssAllowed, clientTagAllowed,
  detectFallback, frameOrigin, isSecretField, planTextEdit, resolveHttpUrl, rewriteCss, rewriteSrcset, sanitizeAttribute, sanitizeMutation,
  sanitizeTree, validateInputMessage,
} from "../services/browser-orchestrator/viewer/mirror-protocol.js";
import { readFileSync } from "node:fs";

const PROXY = "/viewer/00000000-0000-4000-8000-000000000000/m/r/";
const rewritten = [];
const ctx = { base: "https://login.example.edu/idp/", rewrite: (url, kind) => { rewritten.push([url, kind]); return url.includes("deny") ? null : `${PROXY}${"t".repeat(16)}${rewritten.length}`; } };
let nextId = 1;
const el = (n, a = [], c = [], extra = {}) => ({ i: nextId++, t: 1, n, a, c, ...extra });
const txt = (x) => ({ i: nextId++, t: 3, x });
const walk = (node, visit) => { if (!node) return; visit(node); for (const child of node.c || []) walk(child, visit); for (const child of node.sr?.c || []) walk(child, visit); };
const flatten = (node) => { const out = []; walk(node, (item) => out.push(item)); return out; };

test("sanitizer drops script-bearing elements with their subtree", () => {
  const tree = el("div", [], [
    el("script", [], [txt("alert(1)")]), el("noscript", [], [el("img", [["src", "x"], ["onerror", "alert(1)"]])]),
    el("template", [], [el("script")]), el("object", [["data", "javascript:alert(1)"]]), el("embed", [["src", "x.swf"]]),
    el("base", [["href", "https://evil.example/"]]), el("meta", [["http-equiv", "refresh"], ["content", "0;url=javascript:alert(1)"]]),
    el("math", [], [el("mtext")]), el("svg", [], [el("script", [], [txt("alert(1)")], { ns: "svg" }), el("foreignObject", [], [el("iframe")], { ns: "svg" }), el("animate", [["attributeName", "href"], ["to", "javascript:alert(1)"]], [], { ns: "svg" })], { ns: "svg" }),
    el("p", [], [txt("kept")]),
  ]);
  const clean = sanitizeTree(tree, ctx);
  const tags = flatten(clean).filter((node) => node.t === 1).map((node) => node.n);
  assert.deepEqual(tags, ["div", "svg", "p"]);
  assert.equal(flatten(clean).find((node) => node.t === 3).x, "kept");
});

test("sanitizer strips handlers, srcdoc, form actions and script URLs", () => {
  const cases = [
    ["img", "onerror", "alert(1)"], ["body", "onload", "x()"], ["div", "ONCLICK", "x()"], ["iframe", "srcdoc", "<script>alert(1)</script>"],
    ["form", "action", "https://evil.example/steal"], ["button", "formaction", "javascript:alert(1)"], ["a", "href", "javascript:alert(1)"],
    ["a", "href", "https://evil.example/"], ["a", "target", "_top"], ["a", "ping", "https://evil.example/"], ["img", "src", "javascript:alert(1)"],
    ["img", "src", "data:text/html,<script>alert(1)</script>"], ["img", "src", " java\tscript:alert(1)"], ["iframe", "src", "https://idp.example/"],
    ["div", "is", "x-evil"], ["div", "contenteditable", "true"], ["input", "autofocus", ""], ["iframe", "sandbox", "allow-scripts"],
    ["meta", "http-equiv", "refresh"], ["div", "xmlns", "http://www.w3.org/1999/xhtml"], ["video", "poster", "https://x/"],
  ];
  for (const [tag, name, value] of cases) assert.equal(sanitizeAttribute(tag, "html", name, value, ctx), null, `${tag}[${name}=${value}]`);
  assert.equal(sanitizeAttribute("input", "html", "value", "secret", ctx, { type: "password" }), null, "password value never mirrored");
  assert.deepEqual(sanitizeAttribute("input", "html", "type", "evil", ctx), ["type", "text"]);
  assert.deepEqual(sanitizeAttribute("div", "html", "data-x", "javascript:still-just-data", ctx), ["data-x", "javascript:still-just-data"]);
});

test("SVG: local fragments, proxied sprite sheets only, no script URLs or external url()", () => {
  // <use> of an external sprite sheet is proxied under the same host policy as images.
  assert.equal(sanitizeAttribute("use", "svg", "href", "https://deny.example/sprite.svg#a", ctx), null);
  assert.match(sanitizeAttribute("use", "svg", "href", "https://evil.example/sprite.svg#a", ctx)[1], /^\/viewer\/[0-9a-f-]{36}\/m\/r\/[A-Za-z0-9_-]+#a$/);
  assert.equal(sanitizeAttribute("use", "svg", "href", "https://evil.example/sprite.svg", ctx), null, "a sprite reference needs a fragment");
  assert.equal(sanitizeAttribute("image", "svg", "href", "https://deny.example/a.svg#a", ctx), null);
  assert.equal(sanitizeAttribute("use", "svg", "xlink:href", "javascript:alert(1)", ctx), null);
  assert.deepEqual(sanitizeAttribute("use", "svg", "href", "#icon", ctx), ["href", "#icon"]);
  assert.equal(sanitizeAttribute("rect", "svg", "fill", "url(https://evil.example/x#a)", ctx), null);
  assert.deepEqual(sanitizeAttribute("rect", "svg", "fill", "url(#grad)", ctx), ["fill", "url(#grad)"]);
  assert.equal(sanitizeAttribute("svg", "svg", "onload", "alert(1)", ctx), null);
  assert.deepEqual(sanitizeAttribute("svg", "svg", "viewbox", "0 0 1 1", ctx), ["viewBox", "0 0 1 1"]);
});

test("CSS: url()/@import are proxied, script constructs and unsafe data URLs neutralized", () => {
  const css = `@import "theme.css"; a{background:url( 'img/a.png' )} b{width:expression(alert(1))} c{behavior:url(x.htc)} d{-moz-binding:url(x.xml#a)} e{background:url(javascript:alert(1))} f{background:url("data:text/html,<script>")} g{src:url(data:font/woff2;base64,AAAA)} h{background:url(https://deny.example/x.png)} i{fill:url(#g)}`;
  const out = rewriteCss(css, ctx.base, ctx.rewrite);
  assert.doesNotMatch(out, /expression\(|behavior\s*:|-moz-binding|javascript:|data:text/i);
  assert.match(out, /@import url\("\/viewer\/[^"]+"\)/);
  assert.match(out, /url\("\/viewer\/[^"]+"\)/);
  assert.match(out, /url\("data:font\/woff2;base64,AAAA"\)/);
  assert.match(out, /url\("about:invalid"\)/);
  assert.match(out, /url\("#g"\)/);
  assert.ok(clientCssAllowed(out), "server output passes the client check");
  assert.ok(rewritten.some(([url, kind]) => url === "https://login.example.edu/idp/theme.css" && kind === "css"));
  assert.ok(rewritten.some(([url, kind]) => url === "https://login.example.edu/idp/img/a.png" && kind === "media"));
  assert.equal(clientCssAllowed("a{background:url(https://evil.example/x)}"), false);
  assert.equal(clientCssAllowed("a{width:expression(1)}"), false);
});

test("URL resolution and srcset rewriting", () => {
  assert.equal(resolveHttpUrl("../x.png#frag", ctx.base), "https://login.example.edu/x.png");
  assert.equal(resolveHttpUrl("https://user:pw@evil.example/", ctx.base), null);
  assert.equal(resolveHttpUrl("javascript:alert(1)", ctx.base), null);
  assert.equal(resolveHttpUrl("ftp://x/", ctx.base), null);
  assert.equal(resolveHttpUrl("#top", ctx.base), null);
  const srcset = rewriteSrcset("a.png 1x, b.png 2x, javascript:alert(1) 3x, c.png evil", ctx.base, ctx.rewrite);
  assert.equal(srcset.split(", ").length, 2);
  assert.ok(srcset.split(", ").every((part) => part.startsWith(PROXY)));
  assert.equal(sanitizeAttribute("img", "html", "src", "logo.png", ctx)[1].startsWith(PROXY), true);
  assert.equal(sanitizeAttribute("img", "html", "src", "https://deny.example/x.png", ctx), null);
});

test("client re-validation refuses anything the server should have removed", () => {
  assert.equal(clientTagAllowed("script", "html"), false);
  assert.equal(clientTagAllowed("iframe", "html"), true);
  assert.equal(clientTagAllowed("foreignobject", "svg"), false);
  assert.equal(clientAttrAllowed("img", "html", "onerror", "x"), false);
  assert.equal(clientAttrAllowed("img", "html", "src", "https://idp.example/x.png"), false);
  assert.equal(clientAttrAllowed("img", "html", "src", `${PROXY}${"a".repeat(20)}`), true);
  assert.equal(clientAttrAllowed("iframe", "html", "srcdoc", "<b>"), false);
  assert.equal(clientAttrAllowed("a", "html", "href", "javascript:alert(1)"), false);
  assert.equal(clientAttrAllowed("div", "html", "style", "background:url(javascript:alert(1))"), false);
});

test("sanitizeTree keeps input state but never password values; enforces the node cap", () => {
  const clean = sanitizeTree(el("form", [["action", "https://evil.example/"]], [
    el("input", [["type", "email"], ["name", "user"], ["autocomplete", "username"], ["inputmode", "email"]], [], { v: "fake@example.edu" }),
    el("input", [["type", "password"], ["value", "x"]], [], { v: "secret" }),
    el("input", [["type", "hidden"], ["value", "csrf"]]),
  ]), ctx);
  assert.equal(clean.a, undefined, "form action removed");
  const [email, password, hidden] = clean.c;
  assert.equal(email.v, "fake@example.edu");
  assert.deepEqual(email.a, [["type", "email"], ["name", "user"], ["autocomplete", "username"], ["inputmode", "email"]]);
  assert.equal(password.v, undefined);
  assert.ok(!(password.a || []).some(([name]) => name === "value"));
  assert.equal(hidden, undefined, "hidden inputs dropped");
  const wide = el("div", [], Array.from({ length: 50 }, () => el("span")));
  assert.throws(() => sanitizeTree(wide, { ...ctx, maxNodes: 10 }), (error) => error instanceof MirrorLimitError && error.reason === "size");
});

test("sanitizeMutation filters adds and turns rejected attribute changes into removals", () => {
  const out = sanitizeMutation({
    rems: [5, -1, "x"], texts: [{ i: 7, x: "hi" }, { i: "bad", x: "no" }],
    adds: [{ p: 1, b: 2, node: el("script", [], [txt("alert(1)")]) }, { p: 1, node: el("b", [["onclick", "x()"]], [txt("ok")]) }],
    attrs: [{ i: 9, n: "onclick", v: "alert(1)", tag: "div" }, { i: 9, n: "class", v: "x", tag: "div" }, { i: 10, n: "href", v: "javascript:alert(1)", tag: "a" }, { i: 11, n: "title", v: null, tag: "div" }],
  }, ctx);
  assert.deepEqual(out.rems, [5]);
  assert.deepEqual(out.texts, [{ i: 7, x: "hi" }]);
  assert.equal(out.adds.length, 1);
  assert.equal(out.adds[0].node.n, "b");
  assert.equal(out.adds[0].node.a, undefined);
  assert.deepEqual(out.attrs, [{ i: 9, n: "onclick", v: null }, { i: 9, n: "class", v: "x" }, { i: 10, n: "href", v: null }, { i: 11, n: "title", v: null }]);
});

test("input mapping: minimal text edits, click points and message validation", () => {
  assert.equal(planTextEdit("abc", "abc"), null);
  assert.deepEqual(planTextEdit("fake", "fake-x"), { start: 4, end: 4, text: "-x" });
  assert.deepEqual(planTextEdit("fake-x", "fake"), { start: 4, end: 6, text: "" });
  assert.deepEqual(planTextEdit("abXcd", "abYcd"), { start: 2, end: 3, text: "Y" });
  assert.deepEqual(planTextEdit("2024-01-01", "2024-02-01", false), { start: 0, end: 10, text: "2024-02-01", all: true });
  const emoji = planTextEdit("a\u{1F600}", "a\u{1F601}");
  assert.equal(emoji.start, 1, "never splits a surrogate pair");
  assert.deepEqual(clickPoint([10, 20, 110, 20, 110, 60, 10, 60], 0.5, 0.5), { x: 60, y: 40 });
  assert.deepEqual(clickPoint([0, 0, 100, 0, 100, 100, 0, 100], 5, -5), { x: 98, y: 2 }, "clamped inside the element");
  assert.equal(clickPoint([0, 0, 0, 0, 0, 0, 0, 0]), null);
  assert.deepEqual(validateInputMessage({ t: "input", g: 1, f: 0, i: 4, v: "fake" }), { t: "input", g: 1, f: 0, i: 4, v: "fake" });
  assert.equal(validateInputMessage({ t: "input", g: 1, f: 0, i: 4, v: "x".repeat(MIRROR_LIMITS.maxInputValue + 1) }), null);
  assert.equal(validateInputMessage({ t: "eval", code: "x" }), null);
  assert.equal(validateInputMessage({ t: "key", g: 1, k: "F12" }), null);
  assert.deepEqual(validateInputMessage({ t: "click", g: 1, f: 0, i: 3, ox: 9, oy: "x" }), { t: "click", g: 1, f: 0, i: 3, ox: 1, oy: 0.5 });
  assert.equal(validateInputMessage({ t: "viewport", w: 100, h: 800 }), null);
});

test("fallback detector: captcha, canvas-heavy, oversized and errors", () => {
  const base = { vw: 1280, vh: 800, nodes: 500, bytes: 100_000, frames: [], scripts: [], canvasCount: 0, canvasArea: 0 };
  assert.equal(detectFallback(base), null);
  assert.equal(detectFallback({ ...base, frames: ["https://www.google.com/recaptcha/api2/anchor?k=x"] }), "captcha");
  assert.equal(detectFallback({ ...base, scripts: ["https://js.hcaptcha.com/1/api.js"] }), "captcha");
  assert.equal(detectFallback({ ...base, frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"] }), "captcha");
  assert.equal(detectFallback({ ...base, markers: 1 }), "captcha");
  assert.equal(detectFallback({ ...base, canvasCount: 1, canvasArea: 1280 * 800 * 0.5 }), "canvas");
  assert.equal(detectFallback({ ...base, canvasCount: 5, canvasArea: 10 }), "canvas");
  assert.equal(detectFallback({ ...base, nodes: MIRROR_LIMITS.maxNodes + 1 }), "size");
  assert.equal(detectFallback({ ...base, bytes: MIRROR_LIMITS.maxSnapshotBytes + 1 }), "size");
  assert.equal(detectFallback({ ...base, error: "boom" }), "error");
  assert.equal(detectFallback(null), "error");
  assert.equal(detectFallback({ ...base, scripts: ["https://www.google.com/search"] }), null, "a plain google URL is not a captcha");
});

test("secret fields: passwords and one-time codes are recognised; ordinary fields are not", () => {
  assert.equal(isSecretField("input", { type: "password" }), true);
  assert.equal(isSecretField("input", { type: "text", autocomplete: "one-time-code" }), true);
  assert.equal(isSecretField("input", { type: "tel", name: "passcode-input" }), true, "Duo passcode");
  assert.equal(isSecretField("input", { type: "text", name: "credentials.passcode" }), true, "Okta");
  assert.equal(isSecretField("input", { type: "number", id: "otpCode" }), true);
  assert.equal(isSecretField("input", { type: "text", id: "verificationCode" }), true);
  assert.equal(isSecretField("input", { type: "text", name: "mfa_token" }), true);
  assert.equal(isSecretField("input", { type: "text", name: "pin" }), true);
  assert.equal(isSecretField("input", { type: "text", name: "j_username", autocomplete: "username" }), false);
  assert.equal(isSecretField("input", { type: "email", name: "loginfmt", id: "i0116" }), false);
  assert.equal(isSecretField("input", { type: "text", name: "spinner-label" }), false, "'pin' only as a word");
  assert.equal(isSecretField("input", { type: "checkbox", name: "mfa-remember" }), false, "only text entry");
  assert.equal(isSecretField("textarea", { name: "otp" }), false);
});

test("capture.js carries the same secret-field pattern as the protocol", () => {
  const capture = readFileSync(new URL("../services/browser-orchestrator/mirror/capture.js", import.meta.url), "utf8");
  const match = /const SECRET_FIELD = \/(.+)\/i;/.exec(capture);
  assert.ok(match, "SECRET_FIELD found in capture.js");
  assert.equal(match[1], SECRET_FIELD_PATTERN.source);
  assert.equal(SECRET_FIELD_PATTERN.flags, "i");
  // The capture script never serializes a secret value and reports only emptiness.
  assert.match(capture, /if \(secret\) out\.sec = 1; else out\.v = node\.value;/);
  assert.match(capture, /const value = secret \? null : element\.value/);
});

test("sanitizeTree never mirrors one-time-code values (value property or attribute)", () => {
  const clean = sanitizeTree(el("form", [], [
    el("input", [["type", "text"], ["autocomplete", "one-time-code"], ["value", "123456"]], [], { v: "123456" }),
    el("input", [["type", "tel"], ["name", "passcode-input"]], [], { v: "654321" }),
    el("input", [["type", "text"], ["name", "custom"]], [], { v: "112233", sec: 1 }),
    el("input", [["type", "text"], ["name", "username"], ["value", "fake"]], [], { v: "fake" }),
  ]), ctx);
  const [otp, duo, flagged, user] = clean.c;
  for (const field of [otp, duo, flagged]) {
    assert.equal(field.v, undefined);
    assert.ok(!(field.a || []).some(([name]) => name === "value"), "no value attribute");
  }
  assert.equal(user.v, "fake");
  assert.ok(user.a.some(([name, value]) => name === "value" && value === "fake"));
  assert.equal(sanitizeAttribute("input", "html", "value", "123456", ctx, { type: "text", secret: true }), null);
  const mutation = sanitizeMutation({ attrs: [{ i: 3, n: "value", v: "123456", tag: "input", type: "text", sec: 1 }, { i: 4, n: "value", v: "pw", tag: "input", type: "password" }] }, ctx);
  assert.deepEqual(mutation.attrs, [{ i: 3, n: "value", v: null }, { i: 4, n: "value", v: null }]);
  const added = sanitizeMutation({ adds: [{ p: 1, node: el("input", [["autocomplete", "one-time-code"]], [], { v: "999" }) }] }, ctx);
  assert.equal(added.adds[0].node.v, undefined);
});

test("frame origins: about:blank/srcdoc inherit, opaque schemes never match", () => {
  assert.equal(frameOrigin("https://login.ufl.edu/idp/profile/SAML2"), "https://login.ufl.edu");
  assert.equal(frameOrigin("about:blank", "https://login.ufl.edu"), "https://login.ufl.edu");
  assert.equal(frameOrigin("about:srcdoc", "https://login.ufl.edu"), "https://login.ufl.edu");
  assert.equal(frameOrigin("about:blank"), null);
  assert.equal(frameOrigin("data:text/html,<b>x</b>", "https://login.ufl.edu"), null);
  assert.equal(frameOrigin("chrome-error://chromewebdata/"), null);
  assert.equal(frameOrigin("blob:https://login.ufl.edu/0000"), null);
  assert.equal(frameOrigin(""), null);
});

test("fallback detector: a visible cross-origin iframe needs the pixel view", () => {
  const base = { vw: 1280, vh: 800, nodes: 500, frames: [], scripts: [], canvasCount: 0, canvasArea: 0 };
  assert.equal(detectFallback({ ...base, xframes: 1, frames: ["https://api-123.duosecurity.com/frame/web/v1/auth"] }), "frame");
  assert.equal(detectFallback({ ...base, xframes: 0 }), null);
  assert.equal(detectFallback({ ...base, xframes: 1, frames: ["https://www.google.com/recaptcha/api2/anchor"] }), "captcha", "captcha wins");
  assert.equal(typeof FALLBACK_MESSAGES.frame, "string");
  const viewer = readFileSync(new URL("../services/browser-orchestrator/viewer/viewer.js", import.meta.url), "utf8");
  assert.match(viewer, /\n  frame: "/, "the viewer has a notice for the frame fallback");
});
