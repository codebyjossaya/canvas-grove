// Viewer-side DOM mirror. The remote page is rendered as real, sanitized HTML
// inside <iframe sandbox="allow-same-origin" src="m/frame.html">: no
// allow-scripts, and the frame document is served with
// "script-src 'none'; sandbox allow-same-origin", so nothing in it can ever
// execute. This trusted module (the parent) builds the DOM, listens for user
// input and replays it remotely through POST m/input.
import { MirrorFrame } from "./mirror-dom.js";
import { isTextEntry } from "./mirror-protocol.js";

const INPUT_GRACE_MS = 1_500;

export function createMirror({ container, onReady, onFallback, onRestore, onBlank, onLoading, onUnavailable, onDialog, onDialogClosed }) {
  let gen = -1, stream = null, stopped = false, visible = true, ready = false, fallbackGen = -1, blankGen = -1;
  let top = null; // { iframe, frame, key: 0 }
  const frames = new Map(); // key -> { frame: MirrorFrame, doc }
  const pendingChildren = new Map(); // `${ownerKey}:${ownerId}` -> doc message
  const inputState = new WeakMap();
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  let lastUserAction = 0, suppressFocus = false, docQueue = Promise.resolve();

  const post = (message) => fetch("m/input", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(message) })
    .then((response) => response.ok ? response.json() : null).catch(() => null);

  // ---- viewport: the remote lays out at exactly the mirror's size.
  let viewportTimer = 0, lastViewport = "";
  // The mirrored CSS evaluates prefers-color-scheme here; the remote must match it.
  const darkScheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  darkScheme?.addEventListener?.("change", () => reportViewport());
  function reportViewport() {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      const w = Math.round(container.clientWidth), h = Math.round(container.clientHeight);
      if (w < 200 || h < 200 || !visible) return;
      const cs = darkScheme?.matches ? "dark" : "light";
      const key = `${w}x${h}:${cs}`;
      if (key === lastViewport) return;
      lastViewport = key;
      void post({ t: "viewport", w, h, cs });
    }, 150);
  }
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(reportViewport) : null;
  resizeObserver?.observe(container);

  function newTopFrame(quirks) {
    const iframe = document.createElement("iframe");
    iframe.className = "mirror-frame";
    iframe.setAttribute("sandbox", "allow-same-origin");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", "Secure sign-in page");
    iframe.setAttribute("aria-busy", "true");
    iframe.src = quirks ? "m/frame-quirks.html" : "m/frame.html";
    return iframe;
  }

  // Upper bound on holding a page back for its stylesheets and fonts.
  const STYLE_GATE_MS = 1500;
  function stylesReady(doc, limitMs) {
    const started = performance.now();
    const links = [...doc.querySelectorAll('link[rel~="stylesheet"]')].filter((link) => !link.sheet);
    const sheets = Promise.all(links.map((link) => new Promise((done) => { link.addEventListener("load", done, { once: true }); link.addEventListener("error", done, { once: true }); })));
    const fonts = sheets.then(() => { void doc.body?.offsetHeight; return doc.fonts?.ready; });
    return Promise.race([fonts, new Promise((done) => setTimeout(done, limitMs))]).then(() => {
      const waited = Math.round(performance.now() - started);
      if (waited >= limitMs) console.warn(`secure viewer: page shown before its styles finished (${links.length} stylesheet(s), ${waited} ms)`);
    }).catch(() => undefined);
  }

  function loadTop(message) {
    // Build into a fresh sandboxed document, then swap it in: no flash and no
    // state from the previous page survives.
    docQueue = docQueue.then(() => new Promise((resolve) => {
      if (stopped || message.g !== gen) return resolve();
      const iframe = newTopFrame(message.quirks);
      iframe.style.visibility = "hidden";
      iframe.addEventListener("load", async () => {
        try {
          if (stopped || message.g !== gen) { iframe.remove(); return resolve(); }
          const doc = iframe.contentDocument;
          if (!doc) throw new Error("mirror frame is not same-origin");
          const frame = new MirrorFrame(doc, { onFrameElement: (element, id) => childOwnerReady(0, element, id) });
          for (const key of frames.keys()) frames.delete(key);
          frames.set(0, { frame, doc });
          frame.load(message);
          attach(doc, 0, frame);
          // Keep the previous page (or the spinner) up until this one is styled: no flash of
          // unstyled content and no elements popping in one by one.
          await stylesReady(doc, STYLE_GATE_MS);
          if (stopped || message.g !== gen) { iframe.remove(); return resolve(); }
          const previous = top;
          top = { iframe, frame };
          iframe.style.visibility = "";
          iframe.removeAttribute("aria-busy");
          previous?.iframe.remove();
          const win = iframe.contentWindow;
          if (message.scroll && (message.scroll.x || message.scroll.y)) win?.scrollTo(message.scroll.x, message.scroll.y);
          if (message.focus) applyRemoteFocus(0, message.focus);
          container.dataset.loading = "false";
          if (!ready) { ready = true; onReady?.(); }
          if (fallbackGen !== -1 && fallbackGen !== gen) { fallbackGen = -1; onRestore?.(); }
          reportViewport();
        } catch { onFallback?.("error"); }
        resolve();
      }, { once: true });
      container.appendChild(iframe);
    }));
  }

  function childOwnerReady(ownerKey, element, ownerId) {
    const pending = pendingChildren.get(`${ownerKey}:${ownerId}`);
    if (pending) { pendingChildren.delete(`${ownerKey}:${ownerId}`); loadChild(pending, element); }
  }

  function loadChild(message, owner) {
    const doc = owner.contentDocument;
    if (!doc) return;
    const frame = new MirrorFrame(doc, { onFrameElement: (element, id) => childOwnerReady(message.f, element, id) });
    frames.set(message.f, { frame, doc });
    frame.load(message);
    attach(doc, message.f, frame);
  }

  // ---- remote -> local
  function onMessage(message) {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "reset": case "loading":
        if (message.g >= gen) { gen = message.g; pendingChildren.clear(); container.dataset.loading = "true"; onLoading?.(); }
        return;
      case "blank":
        // The remote page must not be shown (signed-in Canvas, browser error page, ...).
        // A non-landed blank may be shown in the pixel view; the next page view restores the mirror.
        gen = message.g; blankGen = gen; pendingChildren.clear(); container.dataset.loading = "true";
        if (message.landed !== 1) fallbackGen = gen;
        onBlank?.(message.landed === 1);
        return;
      case "fallback": if (message.g === gen) { fallbackGen = gen; onFallback?.(message.reason); } return;
      case "unavailable": onUnavailable?.(); return;
      case "jsdialog": onDialog?.(message); return;
      case "jsdialog-closed": onDialogClosed?.(); return;
      case "focus": return;
    }
    if (message.g !== gen && !(message.t === "doc" && message.f === 0 && message.g > gen)) return;
    if (message.t === "doc") {
      if (message.f === 0) { gen = message.g; loadTop(message); return; }
      const owner = message.owner && frames.get(message.owner.f)?.frame.nodes.get(message.owner.i);
      if (owner && owner.localName === "iframe") loadChild(message, owner);
      else if (message.owner) pendingChildren.set(`${message.owner.f}:${message.owner.i}`, message);
      return;
    }
    // Everything else targets an existing frame; wait for a pending top-level build.
    docQueue = docQueue.then(() => applyToFrame(message));
  }

  function applyToFrame(message) {
    if (message.g !== gen) return;
    const entry = frames.get(message.f);
    if (!entry) return;
    const { frame, doc } = entry;
    switch (message.t) {
      case "mut": frame.applyMutation(message); return;
      case "css": frame.setCss(message.i, message.css); return;
      case "adopted": frame.setAdopted(message.i, message.css); return;
      case "canvas": frame.setCanvas(message.i, message.cv); return;
      case "dialog": frame.dialog(message.i, message.open, message.md); return;
      case "rfocus": applyRemoteFocus(message.f, message.i); return;
      case "scroll": {
        if (message.i === 0) return; // the user owns document scrolling locally
        const element = frame.nodes.get(message.i);
        if (element && typeof element.scrollTo === "function" && Date.now() - lastUserAction > INPUT_GRACE_MS) element.scrollTo(message.x, message.y);
        return;
      }
      case "val": {
        const element = frame.nodes.get(message.i);
        if (!element) return;
        applyRemoteValue(element, frame, doc, message);
        return;
      }
    }
  }

  // A remote value that lands while the user is mid-typing (or while an edit is in
  // flight) is deferred, not dropped: the capture side only reports changes, so a
  // dropped value (e.g. remote formatting right after typing) would never be resent.
  // A newer local edit supersedes it (see the input listener).
  function applyRemoteValue(element, frame, doc, message) {
    const state = stateOf(element);
    clearTimeout(state.remoteTimer);
    state.pendingRemote = null;
    const wait = state.busy ? 150 : doc.activeElement === element ? INPUT_GRACE_MS - (Date.now() - state.lastLocal) : 0;
    if (wait <= 0) { frame.setValue(message.i, message); return; }
    state.pendingRemote = message;
    state.remoteTimer = setTimeout(() => {
      if (state.pendingRemote !== message || frame.nodes.get(message.i) !== element) return;
      applyRemoteValue(element, frame, doc, message);
    }, wait);
  }

  function applyRemoteFocus(key, id) {
    // Desktop only: on touch devices a programmatic focus must never be what
    // decides whether the soft keyboard is shown.
    if (coarse || Date.now() - lastUserAction < INPUT_GRACE_MS) return;
    const entry = frames.get(key);
    const element = entry?.frame.nodes.get(id);
    if (!element || entry.doc.activeElement === element) return;
    const info = entry.frame.infoOf(element);
    if (!info || !isTextEntry(info.tag, element.type)) return;
    const active = entry.doc.activeElement;
    if (active && active !== entry.doc.body && active !== entry.doc.documentElement) return;
    suppressFocus = true;
    try { element.focus({ preventScroll: true }); } finally { suppressFocus = false; }
  }

  // ---- local -> remote
  function registered(frame, start) {
    for (let node = start; node; node = node.parentNode || node.host) {
      if (node.nodeType === 1 && frame.idOf(node)) return node;
      if (node.nodeType === 9) return null;
    }
    return null;
  }

  function attach(doc, key, frame) {
    const win = doc.defaultView;
    const targetOf = (event) => registered(frame, event.composedPath ? event.composedPath()[0] : event.target);
    const entryTag = (element) => { const info = frame.infoOf(element); return info ? info.tag : ""; };
    const textEntry = (element) => element && isTextEntry(entryTag(element), element.type);

    doc.addEventListener("click", (event) => {
      lastUserAction = Date.now();
      const element = targetOf(event);
      if (!element) { event.preventDefault(); return; }
      const tag = entryTag(element);
      if (textEntry(element) || tag === "select" || tag === "option" || tag === "optgroup") return; // native focus / picker
      if (tag === "label" && element.control && textEntry(element.control)) return; // focuses the local input
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const keyboard = event.detail === 0 || !rect.width || !rect.height;
      const ox = keyboard ? 0.5 : (event.clientX - rect.left) / rect.width, oy = keyboard ? 0.5 : (event.clientY - rect.top) / rect.height;
      void post({ t: "click", g: gen, f: key, i: frame.idOf(element), ox, oy });
    }, true);
    doc.addEventListener("auxclick", (event) => event.preventDefault(), true);
    doc.addEventListener("submit", (event) => event.preventDefault(), true);
    for (const type of ["dragover", "drop", "dragstart"]) doc.addEventListener(type, (event) => event.preventDefault(), true);

    doc.addEventListener("focusin", (event) => {
      if (suppressFocus) return;
      const element = targetOf(event);
      if (!element) return;
      const tag = entryTag(element);
      if (textEntry(element) || tag === "select") void post({ t: "focus", g: gen, f: key, i: frame.idOf(element) });
    }, true);
    doc.addEventListener("focusout", (event) => {
      // Leaving a field ends the typing grace: apply any deferred remote value now.
      const element = targetOf(event);
      const pending = element && inputState.get(element)?.pendingRemote;
      if (pending && !inputState.get(element).busy) setTimeout(() => { if (inputState.get(element)?.pendingRemote === pending && doc.activeElement !== element) applyRemoteValue(element, frame, doc, pending); }, 0);
    }, true);

    doc.addEventListener("input", (event) => {
      lastUserAction = Date.now();
      const element = targetOf(event);
      if (!textEntry(element)) return;
      const state = stateOf(element);
      state.lastLocal = Date.now();
      state.pendingRemote = null; clearTimeout(state.remoteTimer);
      if (state.composing) return;
      queueInput(element, key, frame);
    }, true);
    doc.addEventListener("compositionstart", (event) => { const element = targetOf(event); if (element) stateOf(element).composing = true; }, true);
    doc.addEventListener("compositionend", (event) => {
      const element = targetOf(event);
      if (!textEntry(element)) return;
      stateOf(element).composing = false;
      queueInput(element, key, frame);
    }, true);
    doc.addEventListener("change", (event) => {
      const element = targetOf(event);
      if (element && entryTag(element) === "select") void post({ t: "select", g: gen, f: key, i: frame.idOf(element), v: element.value });
    }, true);
    doc.addEventListener("keydown", (event) => {
      lastUserAction = Date.now();
      if (event.isComposing || event.keyCode === 229) return;
      const element = targetOf(event);
      if (event.key === "Enter" && element && textEntry(element) && entryTag(element) !== "textarea") {
        // Stop local implicit submission (which would also synthesize a click); submit remotely once.
        event.preventDefault();
        void flushInput(element, key, frame).then(() => post({ t: "key", g: gen, f: key, i: frame.idOf(element), k: "Enter" }));
      } else if (event.key === "Escape") {
        void post({ t: "key", g: gen, f: key, k: "Escape" });
      }
    }, true);
    let scrollTimer = 0;
    win?.addEventListener("scroll", () => {
      lastUserAction = Date.now();
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = 0; void post({ t: "scroll", g: gen, f: key, i: 0, x: Math.round(win.scrollX), y: Math.round(win.scrollY) }); }, 200);
    }, { passive: true });
  }

  function stateOf(element) {
    let state = inputState.get(element);
    if (!state) { state = { busy: false, dirty: false, lastLocal: 0, composing: false, flight: Promise.resolve(), pendingRemote: null, remoteTimer: 0 }; inputState.set(element, state); }
    return state;
  }

  function queueInput(element, key, frame) {
    const state = stateOf(element);
    if (state.busy) { state.dirty = true; return state.flight; }
    state.flight = sendInput(element, key, frame, state);
    return state.flight;
  }
  function flushInput(element, key, frame) {
    const state = stateOf(element);
    return state.busy ? state.flight.then(() => undefined) : queueInput(element, key, frame);
  }
  async function sendInput(element, key, frame, state) {
    state.busy = true; state.dirty = false;
    const value = element.value;
    const result = await post({ t: "input", g: gen, f: key, i: frame.idOf(element), v: value });
    state.busy = false;
    if (state.dirty || element.value !== value) return sendInput(element, key, frame, state);
    // Remote-side formatting (e.g. a page that trims or reformats) wins once typing settles.
    if (result && typeof result.v === "string" && result.v !== value && element.value === value) element.value = result.v;
  }

  // ---- lifecycle
  function start() {
    stopped = false;
    stream = new EventSource("m/stream");
    stream.addEventListener("message", (event) => { try { onMessage(JSON.parse(event.data)); } catch { /* malformed event */ } });
    stream.addEventListener("error", () => { if (!ready) onUnavailable?.(); });
    reportViewport();
  }
  function stop() { stopped = true; stream?.close(); stream = null; resizeObserver?.disconnect(); top?.iframe.remove(); top = null; frames.clear(); }
  function setVisible(value) {
    visible = value;
    if (value) { lastViewport = ""; reportViewport(); void post({ t: "renderer", r: "mirror" }); }
    else void post({ t: "renderer", r: "pixels" });
  }
  return { start, stop, setVisible, answerDialog: (accept) => post({ t: "jsdialog", accept }), get ready() { return ready; }, get blank() { return blankGen !== -1 && blankGen === gen; } };
}
