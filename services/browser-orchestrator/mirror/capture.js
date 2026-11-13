// Canvas Grove DOM-mirror capture script. Injected by the orchestrator over CDP
// into an ISOLATED WORLD ("cgmirror") of every frame of the remote sign-in
// browser. It shares the DOM with the page but none of the page's JavaScript
// globals, so page scripts can neither see nor call it. It reports through a
// CDP binding that exists only in this world.
//
// It never reads cookies, storage, or password values, and never serializes
// <input type=hidden> (SAML/CSRF tokens) or <script> contents.
(() => {
  "use strict";
  if (globalThis.__cgm) return;
  const BINDING = "__cgmEmit";
  const SVG_NS = "http://www.w3.org/2000/svg", HTML_NS = "http://www.w3.org/1999/xhtml";
  const SKIP = new Set(["script", "noscript", "template", "meta", "base", "title", "object", "embed", "applet", "param", "frameset", "frame", "noframes", "portal"]);
  const MAX_NODES = 30000, MAX_MESSAGE = 6 * 1024 * 1024, MAX_ATTRS = 200;
  const CAPTCHA_MARKERS = ".g-recaptcha,.h-captcha,.cf-turnstile,[data-hcaptcha-widget-id],iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='challenges.cloudflare.com']";
  const TEXT_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "week", "time"]);
  // Copy of SECRET_FIELD_PATTERN in viewer/mirror-protocol.js (kept equal by tests/mirror-protocol.test.mjs).
  const SECRET_FIELD = /one-time-code|otp|passcode|passwd|password|totp|mfa|2fa|two[-_ ]?factor|verif\w*[-_ ]?code|security[-_ ]?code|auth\w*[-_ ]?code|sms[-_ ]?code|(?:^|[^a-z])pin(?:[^a-z]|$)/i;
  const MIN_FRAME_AREA = 2500; // px^2: smaller (or hidden/offscreen) cross-origin iframes do not force the pixel view
  const everSecret = new WeakSet();

  const ids = new WeakMap(), nodes = new Map();
  let nextId = 1, mode = null, observer = null, budget = 0, started = false;
  let observedRoots = new WeakSet();
  const inputs = new Map(), canvases = new Map(), styles = new Map();
  let adoptedLast = "";
  let pendingAdded = new Set(), pendingRems = [], pendingAttrs = new Map(), pendingTexts = new Map(), pendingCss = new Set(), pendingDialogs = new Set();
  let flushTimer = 0, lastSummary = "";

  const emit = (message) => {
    try {
      const text = JSON.stringify(message);
      if (text.length > MAX_MESSAGE) { globalThis[BINDING](JSON.stringify({ t: "error", reason: "size" })); return; }
      globalThis[BINDING](text);
    } catch { /* binding not ready or serialization failure */ }
  };
  const idOf = (node) => { let id = ids.get(node); if (!id) { id = nextId++; ids.set(node, id); nodes.set(id, node); } return id; };
  const known = (node) => ids.has(node) && nodes.get(ids.get(node)) === node;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  function cssOf(style) {
    const sheet = style.sheet;
    const rules = safe(() => sheet && sheet.cssRules, null);
    if (rules && rules.length) { let text = ""; for (const rule of rules) text += rule.cssText + "\n"; return text; }
    return style.textContent || "";
  }
  function sheetsText(list) {
    const out = [];
    for (const sheet of list || []) { const rules = safe(() => sheet.cssRules, null); if (!rules) continue; let text = ""; for (const rule of rules) text += rule.cssText + "\n"; out.push(text); }
    return out;
  }
  function canvasData(canvas) {
    if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4096 * 4096) return undefined;
    return safe(() => canvas.toDataURL("image/webp", 0.85), undefined);
  }
  const isModal = (dialog) => safe(() => dialog.matches(":modal"), false);
  // Passwords and one-time codes: the value never leaves this browser, only
  // "empty / non-empty". Once secret, an input stays secret (a "show password"
  // toggle that switches it to type=text does not reveal it to the mirror).
  function isSecret(node) {
    if (node.localName !== "input") return false;
    if (everSecret.has(node)) return true;
    const type = String(node.type || "text").toLowerCase();
    let secret = type === "password";
    if (!secret && TEXT_TYPES.has(type)) {
      secret = [node.getAttribute("autocomplete"), node.getAttribute("name"), node.id].some((value) => value && SECRET_FIELD.test(value)) ||
        safe(() => { const masked = getComputedStyle(node).webkitTextSecurity; return Boolean(masked) && masked !== "none"; }, false);
    }
    if (secret) everSecret.add(node);
    return secret;
  }

  function serialize(node, depth) {
    if (depth > 256) return null;
    if (node.nodeType === 3) { if (++budget > MAX_NODES) throw new Error("size"); return { i: idOf(node), t: 3, x: node.data }; }
    if (node.nodeType !== 1) return null;
    const svg = node.namespaceURI === SVG_NS;
    if (!svg && node.namespaceURI !== HTML_NS) return null;
    const tag = node.localName;
    if (!svg && SKIP.has(tag)) return null;
    if (svg && (tag === "script" || tag === "foreignObject")) return null;
    if (tag === "input" && node.type === "hidden") return null;
    if (tag === "link" && !/(^|\s)stylesheet(\s|$)/i.test(node.rel || "")) return null;
    if (++budget > MAX_NODES) throw new Error("size");
    const id = idOf(node);
    const out = { i: id, t: 1, n: tag };
    if (svg) out.ns = "svg";
    const attrs = node.attributes;
    const secretAttrs = tag === "input" && isSecret(node);
    if (attrs.length) { out.a = []; for (let k = 0; k < attrs.length && k < MAX_ATTRS; k += 1) if (!(secretAttrs && attrs[k].name === "value")) out.a.push([attrs[k].name, attrs[k].value]); }
    if (tag === "style") { out.css = cssOf(node); styles.set(id, safe(() => node.sheet.cssRules.length, -1)); return out; }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const secret = isSecret(node);
      if (secret) out.sec = 1; else out.v = node.value;
      if (tag === "input" && (node.type === "checkbox" || node.type === "radio")) out.ck = node.checked;
      inputs.set(id, { v: secret ? null : node.value, ck: node.checked, empty: secret ? node.value === "" : undefined });
      if (tag === "textarea") return out;
    }
    if (tag === "dialog" && node.open && isModal(node)) out.md = 1;
    if (tag === "canvas") { const data = canvasData(node); if (data) out.cv = data; canvases.set(id, data ? data.length : 0); return out; }
    if (tag === "iframe") return out;
    const children = [];
    for (let child = node.firstChild; child; child = child.nextSibling) { const item = serialize(child, depth + 1); if (item) children.push(item); }
    if (children.length) out.c = children;
    const root = node.shadowRoot;
    if (root) {
      observe(root);
      const shadow = { i: idOf(root), c: [] };
      for (let child = root.firstChild; child; child = child.nextSibling) { const item = serialize(child, depth + 1); if (item) shadow.c.push(item); }
      const adopted = sheetsText(safe(() => root.adoptedStyleSheets, []));
      if (adopted.length) shadow.css = adopted;
      out.sr = shadow;
    }
    return out;
  }

  function deepActive() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }
  function editableInfo(element) {
    if (!element || element === document.body || element === document.documentElement) return { editable: false, inputType: "" };
    const tag = element.localName;
    if (tag === "textarea") return { editable: !element.readOnly && !element.disabled, inputType: "textarea" };
    if (tag === "input") { const type = (element.type || "text").toLowerCase(); return { editable: TEXT_TYPES.has(type) && !element.readOnly && !element.disabled, inputType: type }; }
    if (element.isContentEditable) return { editable: true, inputType: "contenteditable" };
    return { editable: false, inputType: tag === "iframe" ? "frame" : "" };
  }

  function observe(root) {
    if (!observer || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  function onMutations(records) {
    for (const record of records) {
      const target = record.target;
      if (record.type === "childList") {
        if (target.nodeType === 1 && target.localName === "style") { pendingCss.add(target); continue; }
        for (const node of record.removedNodes) {
          pendingAdded.delete(node);
          if (known(node)) { pendingRems.push(ids.get(node)); nodes.delete(ids.get(node)); }
        }
        for (const node of record.addedNodes) pendingAdded.add(node);
      } else if (record.type === "attributes") {
        if (!known(target)) continue;
        const id = ids.get(target);
        let entry = pendingAttrs.get(id);
        if (!entry) { entry = new Map(); pendingAttrs.set(id, entry); }
        entry.set(record.attributeName, target.getAttribute(record.attributeName));
        if (target.localName === "dialog" && record.attributeName === "open") pendingDialogs.add(target);
      } else if (record.type === "characterData") {
        const parent = target.parentNode;
        if (parent && parent.nodeType === 1 && parent.localName === "style") pendingCss.add(parent);
        else if (known(target)) pendingTexts.set(ids.get(target), target.data);
      }
    }
    schedule();
  }

  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 40); }
  const parentOf = (node) => node.parentNode;
  function coveredByPending(node) {
    for (let parent = parentOf(node); parent; parent = parent.nodeType === 11 ? parent.host : parentOf(parent)) if (pendingAdded.has(parent)) return true;
    return false;
  }
  function flush() {
    flushTimer = 0;
    if (mode !== "mirror") { pendingAdded.clear(); pendingRems = []; pendingAttrs.clear(); pendingTexts.clear(); pendingCss.clear(); pendingDialogs.clear(); return; }
    const message = { t: "mut", rems: pendingRems, adds: [], attrs: [], texts: [] };
    const added = [...pendingAdded].filter((node) => node.isConnected && !coveredByPending(node));
    added.sort((a, b) => { const position = a.compareDocumentPosition(b); return position & 4 ? -1 : position & 2 ? 1 : 0; });
    budget = nodes.size;
    try {
      for (const node of added) {
        const parent = parentOf(node);
        if (!parent || !known(parent)) continue;
        const item = serialize(node, 0);
        if (!item) continue;
        let sibling = node.nextSibling;
        while (sibling && (pendingAdded.has(sibling) || !known(sibling))) sibling = sibling.nextSibling;
        message.adds.push({ p: ids.get(parent), b: sibling ? ids.get(sibling) : null, sr: parent.nodeType === 11 ? 1 : undefined, node: item });
      }
    } catch { emit({ t: "error", reason: "size" }); }
    for (const [id, entry] of pendingAttrs) {
      const element = nodes.get(id);
      if (!element) continue;
      const sec = isSecret(element) ? 1 : undefined;
      for (const [name, value] of entry) message.attrs.push({ i: id, n: name, v: sec && name === "value" ? null : value, tag: element.localName, ns: element.namespaceURI === SVG_NS ? "svg" : undefined, type: element.localName === "input" ? element.type : undefined, sec, a: element.localName === "link" ? [["rel", element.rel || ""]] : undefined });
    }
    for (const [id, text] of pendingTexts) message.texts.push({ i: id, x: text });
    pendingAdded = new Set(); pendingRems = []; pendingAttrs.clear(); pendingTexts.clear();
    if (message.rems.length || message.adds.length || message.attrs.length || message.texts.length) emit(message);
    for (const style of pendingCss) if (known(style)) { emit({ t: "css", i: ids.get(style), css: cssOf(style) }); styles.set(ids.get(style), safe(() => style.sheet.cssRules.length, -1)); }
    pendingCss.clear();
    for (const dialog of pendingDialogs) if (known(dialog)) emit({ t: "dialog", i: ids.get(dialog), open: dialog.open, md: dialog.open && isModal(dialog) ? 1 : 0 });
    pendingDialogs.clear();
  }

  function summary() {
    const frames = [], scripts = [];
    for (const frame of document.querySelectorAll("iframe[src]")) if (frames.length < 30) frames.push(String(frame.src).slice(0, 300));
    for (const script of document.querySelectorAll("script[src]")) if (scripts.length < 60) scripts.push(String(script.src).slice(0, 300));
    let canvasArea = 0, canvasCount = 0, xframes = 0;
    const vw = innerWidth, vh = innerHeight;
    // Cross-origin iframes are never mirrored (contentDocument is null from here);
    // a visible one makes the page need the pixel view.
    for (const frame of document.querySelectorAll("iframe")) {
      if (safe(() => frame.contentDocument, null)) continue;
      const rect = frame.getBoundingClientRect();
      const w = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)), h = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      if (w * h < MIN_FRAME_AREA) continue;
      const style = safe(() => getComputedStyle(frame), null);
      if (style && (style.visibility === "hidden" || Number(style.opacity) === 0)) continue;
      xframes += 1;
    }
    for (const canvas of document.querySelectorAll("canvas")) {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)), h = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      if (w * h > 400) { canvasArea += w * h; canvasCount += 1; }
    }
    return { t: "summary", frames, scripts, markers: safe(() => document.querySelectorAll(CAPTCHA_MARKERS).length, 0), canvasArea, canvasCount, xframes, nodes: nodes.size, vw, vh };
  }

  function snapshot() {
    if (mode !== "mirror" || !document.documentElement) return;
    nodes.clear(); inputs.clear(); canvases.clear(); styles.clear();
    budget = 0;
    let root = null, error;
    try { root = serialize(document.documentElement, 0); } catch (caught) { error = String(caught && caught.message || "error"); }
    if (error || !root) { emit({ t: "error", reason: error === "size" ? "size" : "error" }); return; }
    const adopted = sheetsText(safe(() => document.adoptedStyleSheets, []));
    adoptedLast = adopted.join("\n");
    const active = deepActive();
    emit({ t: "doc", url: location.href, base: document.baseURI, quirks: document.compatMode === "BackCompat", root, adopted,
      scroll: { x: scrollX, y: scrollY }, focus: active && known(active) ? ids.get(active) : 0, vw: innerWidth, vh: innerHeight });
    const info = summary(); lastSummary = JSON.stringify(info); emit(info);
  }

  let scrollTimer = 0; const scrollPending = new Set();
  function onScroll(event) {
    if (mode !== "mirror") return;
    const target = event.target;
    scrollPending.add(target === document || target === document.documentElement || target === document.scrollingElement ? document : target);
    if (!scrollTimer) scrollTimer = setTimeout(() => {
      scrollTimer = 0;
      for (const item of scrollPending) {
        if (item === document) emit({ t: "scroll", i: 0, x: scrollX, y: scrollY });
        else if (known(item)) emit({ t: "scroll", i: ids.get(item), x: item.scrollLeft, y: item.scrollTop });
      }
      scrollPending.clear();
    }, 120);
  }

  let focusTimer = 0;
  function onFocus() {
    if (!mode || focusTimer) return;
    focusTimer = setTimeout(() => {
      focusTimer = 0;
      const active = deepActive();
      const info = editableInfo(active);
      emit({ t: "focus", i: active && known(active) ? ids.get(active) : 0, editable: info.editable, inputType: info.inputType, top: window === window.top });
    }, 0);
  }

  function poll() {
    if (mode !== "mirror") return;
    for (const [id, last] of inputs) {
      const element = nodes.get(id);
      if (!element || !element.isConnected) { inputs.delete(id); continue; }
      const secret = isSecret(element);
      const value = secret ? null : element.value, checked = element.checked;
      if (secret) {
        const empty = element.value === "";
        if (empty !== last.empty) { last.empty = empty; emit({ t: "val", i: id, pw: empty ? 0 : 1 }); }
        continue;
      }
      if (value !== last.v || checked !== last.ck) { last.v = value; last.ck = checked; emit({ t: "val", i: id, v: value, ck: checked }); }
    }
  }
  function slowPoll() {
    if (mode !== "mirror") return;
    for (const [id, length] of styles) {
      const style = nodes.get(id);
      if (!style || !style.isConnected) { styles.delete(id); continue; }
      const current = safe(() => style.sheet.cssRules.length, -1);
      if (current !== length) { styles.set(id, current); emit({ t: "css", i: id, css: cssOf(style) }); }
    }
    const adopted = sheetsText(safe(() => document.adoptedStyleSheets, []));
    const joined = adopted.join("\n");
    if (joined !== adoptedLast) { adoptedLast = joined; emit({ t: "adopted", i: 0, css: adopted }); }
    for (const [id, length] of canvases) {
      const canvas = nodes.get(id);
      if (!canvas || !canvas.isConnected) { canvases.delete(id); continue; }
      const data = canvasData(canvas);
      if (data && data.length !== length) { canvases.set(id, data.length); emit({ t: "canvas", i: id, cv: data }); }
    }
    const info = summary(), text = JSON.stringify(info);
    if (text !== lastSummary) { lastSummary = text; emit(info); }
  }

  let timers = [];
  function start(nextMode) {
    mode = nextMode === "mirror" ? "mirror" : "focus";
    if (!started) {
      started = true;
      addEventListener("focusin", onFocus, true); addEventListener("focusout", onFocus, true);
      addEventListener("scroll", onScroll, true);
      for (const type of ["input", "change"]) addEventListener(type, () => setTimeout(poll, 0), true);
    }
    if (mode === "mirror") {
      if (!observer) { observer = new MutationObserver(onMutations); }
      const begin = () => { observe(document); snapshot(); };
      if (document.readyState === "loading") addEventListener("DOMContentLoaded", begin, { once: true }); else begin();
      timers.forEach(clearInterval);
      timers = [setInterval(poll, 250), setInterval(slowPoll, 1000)];
    }
    onFocus();
  }

  globalThis.__cgm = Object.freeze({
    start,
    resnap: () => { if (mode === "mirror") snapshot(); },
    node: (id) => nodes.get(id) || null,
    idOf: (node) => idOf(node),
    secret: (node) => Boolean(node && node.nodeType === 1 && isSecret(node)),
    stop: () => { mode = null; timers.forEach(clearInterval); timers = []; if (observer) observer.disconnect(); observedRoots = new WeakSet(); },
  });
  emit({ t: "hello", top: window === window.top });
})();
