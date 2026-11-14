// DOM-mirror engine: one per remote sign-in browser while a viewer is open.
// Speaks CDP to the remote Chromium through a relay "mirror" capability, runs
// mirror/capture.js in an isolated world of every frame, sanitizes what it
// reports (viewer/mirror-protocol.js) and fans the result out to viewer
// subscribers. It also replays viewer input (click, focus, text, keys) with
// CDP Input.* at the element's current remote coordinates.
//
// Nothing here executes page JavaScript in the user's browser: only sanitized
// node descriptions leave this module.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  clickPoint, detectFallback, frameOrigin, MIRROR_LIMITS, MirrorLimitError, planTextEdit, rewriteCss, safeCanvasData, SECRET_FIELD_PATTERN,
  sanitizeMutation, sanitizeTree, supportsSelection,
} from "../viewer/mirror-protocol.js";

const CAPTURE_SOURCE = readFileSync(new URL("./capture.js", import.meta.url), "utf8");
// Every engine injects into its OWN isolated world. Worlds outlive the CDP session that
// created them, so a shared name made a new engine pick up a stale world whose binding
// belonged to a closed session (its snapshots went nowhere).
const WORLD_PREFIX = "cgmirror", BINDING = "__cgmEmit";
// Prefetched as soon as a token is minted: stylesheets (fully), and fonts only when the
// remote browser already holds them (the ones the page really uses; never a new download).
const PREFETCH_FONT = /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i;
const CALL_TIMEOUT_MS = 10_000;
const VALUE_TYPES = new Set(["date", "datetime-local", "month", "week", "time", "color", "range"]);
const safeCall = (fn) => { try { return fn(); } catch { return undefined; } };
// Runs in the remote page (CDP callFunctionOn): edit state of an input, never a secret value.
const SECRET_SOURCE = SECRET_FIELD_PATTERN.source, SECRET_FLAGS = SECRET_FIELD_PATTERN.flags;
const INPUT_STATE_FN = `function(){const t=this.localName;if(t!=='input'&&t!=='textarea')return null;const type=(this.type||'text').toLowerCase();`
  + `const re=new RegExp(${JSON.stringify(SECRET_SOURCE)},${JSON.stringify(SECRET_FLAGS)});`
  + `let masked=false;try{const m=getComputedStyle(this).webkitTextSecurity;masked=Boolean(m)&&m!=='none'}catch(_){}`
  + `const known=globalThis.__cgm&&globalThis.__cgm.secret?globalThis.__cgm.secret(this):false;`
  + `const secret=t==='input'&&(known||type==='password'||masked||[this.getAttribute('autocomplete'),this.getAttribute('name'),this.id].some((v)=>v&&re.test(v)));`
  + `return{tag:t,type,secret,value:secret?null:this.value,len:this.value.length,ro:this.readOnly||this.disabled}}`;

/** Minimal flattened-session CDP client over the platform WebSocket. */
export class CdpConnection {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.listeners = new Set(); this.closed = false; }
  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => { reject(new Error("CDP connect timeout")); try { socket.close(); } catch { /* ignore */ } }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")); });
      socket.addEventListener("close", () => {
        clearTimeout(timer); this.closed = true;
        for (const { reject: fail, timer: callTimer } of this.pending.values()) { clearTimeout(callTimer); fail(new Error("CDP closed")); }
        this.pending.clear();
        for (const listener of this.listeners) listener("__closed", {}, undefined);
      });
      socket.addEventListener("message", async (event) => {
        let message;
        try { message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(await event.data.arrayBuffer?.() ?? event.data).toString("utf8")); } catch { return; }
        if (message.id) {
          const call = this.pending.get(message.id);
          if (!call) return;
          this.pending.delete(message.id); clearTimeout(call.timer);
          if (message.error) call.reject(Object.assign(new Error(message.error.message || "CDP error"), { cdp: true }));
          else call.resolve(message.result || {});
          return;
        }
        for (const listener of this.listeners) listener(message.method, message.params || {}, message.sessionId);
      });
    });
  }
  send(method, params = {}, sessionId) {
    if (this.closed || !this.socket) return Promise.reject(new Error("CDP closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(listener) { this.listeners.add(listener); }
  close() { this.closed = true; try { this.socket?.close(); } catch { /* ignore */ } }
}

const MAGIC = [
  [(b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, "image/png"],
  [(b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, "image/jpeg"],
  [(b) => b.slice(0, 4).toString("latin1") === "GIF8", "image/gif"],
  [(b) => b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP", "image/webp"],
  [(b) => b.slice(4, 8).toString("latin1") === "ftyp" && /avi[fs]/.test(b.slice(8, 12).toString("latin1")), "image/avif"],
  [(b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0, "image/x-icon"],
  [(b) => b.slice(0, 2).toString("latin1") === "BM", "image/bmp"],
  [(b) => b.slice(0, 4).toString("latin1") === "wOFF", "font/woff"],
  [(b) => b.slice(0, 4).toString("latin1") === "wOF2", "font/woff2"],
  [(b) => b.slice(0, 4).toString("latin1") === "OTTO", "font/otf"],
  [(b) => b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0 || b.slice(0, 4).toString("latin1") === "true", "font/ttf"],
];
/** Content type from magic bytes only; the remote server's Content-Type is never trusted. */
export function sniffMedia(body) {
  if (!Buffer.isBuffer(body) || body.length < 4) return null;
  for (const [test, type] of MAGIC) if (test(body)) return type;
  let head = body.slice(0, 1024).toString("utf8");
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  head = head.trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export class MirrorEngine {
  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {() => Promise<string>} options.connectUrl  browser-level CDP WebSocket URL (via relay capability)
   * @param {(host: string) => boolean} options.resourceHostAllowed  egress policy for proxied subresources
   * @param {(url: string) => boolean} options.mirrorable  top-level URL may be shown (allowed and not landed)
   * @param {(url: string) => boolean} [options.landed]  top-level URL is the signed-in Canvas page (viewer hint only)
   * @param {{ mobile?: boolean }} options.display
   */
  constructor({ sessionId, connectUrl, resourceHostAllowed, mirrorable, landed = () => false, display, log = () => undefined }) {
    Object.assign(this, { sessionId, connectUrl, resourceHostAllowed, mirrorable, landed, display: display || {}, log });
    this.world = `${WORLD_PREFIX}-${randomBytes(6).toString("hex")}`;
    this.resourceInflight = new Map();
    this.prefix = `/viewer/${sessionId}/m/`;
    this.subscribers = new Set();
    this.closed = false;
    this.gen = 0;
    this.pixels = false;
    this.viewport = null;
    this.reset();
  }

  reset() {
    this.targets = new Map(); // targetId -> { sessionId, url, attachedAt }
    this.sessions = new Map(); // sessionId -> { targetId, pageSessionId, type }
    this.frames = new Map(); // frameId -> { frameId, sessionId, pageSessionId, parentFrameId, contextId, key, url, started }
    this.contexts = new Map(); // `${sessionId}:${contextId}` -> frameId
    this.keyToFrame = new Map(); this.nextKey = 1;
    this.activeTargetId = null;
    this.resources = new Map(); this.resourceIndex = new Map(); this.resourceBytes = 0; this.resourceCache = new Map(); this.cacheBytes = 0;
    this.focusState = { editable: false, inputType: "", rect: null };
    this.fallbackGen = -1;
    this.mainState = "none";
    this.dialog = null;
  }

  get wantsMirror() { for (const subscriber of this.subscribers) if (subscriber.mode === "mirror") return true; return false; }

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    if (!this.cdp && !this.connecting) void this.connect();
    else if (subscriber.mode === "mirror") void this.resendAll(subscriber);
    else subscriber.send({ t: "focus", ...this.focusState });
    return () => { this.subscribers.delete(subscriber); };
  }

  broadcast(message, mode) {
    for (const subscriber of this.subscribers) if (!mode || subscriber.mode === mode) { try { subscriber.send(message); } catch { /* subscriber gone */ } }
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.cdp?.close(); this.cdp = null;
    this.subscribers.clear();
  }

  async connect() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    try {
      const url = await this.connectUrl();
      const cdp = new CdpConnection(url);
      await cdp.open();
      if (this.closed) { cdp.close(); return; }
      this.reset();
      this.cdp = cdp;
      cdp.on((method, params, sessionId) => { void this.onEvent(method, params, sessionId).catch(() => undefined); });
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      const { targetInfos = [] } = await cdp.send("Target.getTargets");
      for (const info of targetInfos) if (info.type === "page") await this.attach(info).catch(() => undefined);
      this.log({ event: "mirror_connected", pages: this.targets.size });
    } catch (error) {
      this.log({ event: "mirror_connect_failed", code: String(error?.message || "error").slice(0, 60) });
      this.cdp = null;
      if (!this.closed && this.subscribers.size) this.reconnectTimer = setTimeout(() => void this.connect(), 2_000);
      else this.broadcast({ t: "unavailable" });
    } finally { this.connecting = false; }
  }

  send(method, params, sessionId) { if (!this.cdp) return Promise.reject(new Error("CDP closed")); return this.cdp.send(method, params, sessionId); }

  async attach(info) {
    if (this.targets.has(info.targetId)) return;
    this.targets.set(info.targetId, { sessionId: null, url: info.url, attachedAt: Date.now() });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    const target = this.targets.get(info.targetId);
    if (!target) return;
    target.sessionId = sessionId;
    this.sessions.set(sessionId, { targetId: info.targetId, pageSessionId: sessionId, type: "page" });
    await this.setupSession(sessionId, sessionId);
    this.chooseActive();
  }

  async setupSession(sessionId, pageSessionId) {
    await Promise.all([
      this.send("Page.enable", {}, sessionId), this.send("Runtime.enable", {}, sessionId), this.send("DOM.enable", {}, sessionId).catch(() => undefined),
      this.send("Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 }, sessionId).catch(() => undefined),
    ]);
    await this.send("Runtime.addBinding", { name: BINDING, executionContextName: this.world }, sessionId);
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => undefined);
    const { frameTree } = await this.send("Page.getFrameTree", {}, sessionId);
    const walk = (node, parentFrameId) => {
      this.registerFrame(node.frame.id, sessionId, pageSessionId, parentFrameId ?? node.frame.parentId, node.frame.url);
      for (const child of node.childFrames || []) walk(child, node.frame.id);
    };
    walk(frameTree);
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: CAPTURE_SOURCE, worldName: this.world, runImmediately: true }, sessionId);
    // Older builds ignore runImmediately: create the world explicitly where missing.
    setTimeout(() => {
      for (const frame of this.frames.values()) {
        if (frame.sessionId !== sessionId || frame.contextId) continue;
        void this.send("Page.createIsolatedWorld", { frameId: frame.frameId, worldName: this.world, grantUniveralAccess: false }, sessionId)
          .then(({ executionContextId }) => this.send("Runtime.evaluate", { expression: CAPTURE_SOURCE, contextId: executionContextId }, sessionId)).catch(() => undefined);
      }
    }, 1_500);
  }

  registerFrame(frameId, sessionId, pageSessionId, parentFrameId, url) {
    const existing = this.frames.get(frameId);
    if (existing) {
      // An out-of-process frame is first seen from its parent, then owned by its
      // own (iframe-type) session, which always wins.
      if (sessionId !== existing.sessionId && this.sessions.get(sessionId)?.type !== "iframe" && this.sessions.has(existing.sessionId)) return existing;
      Object.assign(existing, { sessionId, pageSessionId, url: url ?? existing.url, parentFrameId: parentFrameId ?? existing.parentFrameId });
      return existing;
    }
    const frame = { frameId, sessionId, pageSessionId, parentFrameId: parentFrameId || null, contextId: null, key: null, url: url || "", started: false };
    this.frames.set(frameId, frame);
    return frame;
  }

  pageFrame(pageSessionId) { for (const frame of this.frames.values()) if (frame.pageSessionId === pageSessionId && !frame.parentFrameId) return frame; return null; }
  activeSession() { return this.activeTargetId ? this.targets.get(this.activeTargetId)?.sessionId : null; }

  chooseActive() {
    let best = null;
    for (const [targetId, target] of this.targets) {
      if (!target.sessionId) continue;
      const blank = !target.url || target.url === "about:blank";
      if (!best || (best.blank && !blank) || (best.blank === blank && target.attachedAt >= best.target.attachedAt)) best = { targetId, target, blank };
    }
    const next = best?.targetId ?? null;
    if (next === this.activeTargetId) return;
    this.activeTargetId = next;
    this.newGeneration();
    void this.applyViewport();
    for (const frame of this.frames.values()) if (frame.pageSessionId === best?.target.sessionId && frame.contextId) void this.startFrame(frame);
  }

  newGeneration() {
    this.gen += 1;
    this.keyToFrame.clear(); this.nextKey = 1;
    for (const frame of this.frames.values()) { frame.key = null; frame.started = false; frame.owner = null; }
    // Keep the previous generation's resources briefly so in-flight loads complete.
    for (const [token, entry] of this.resources) if (entry.gen < this.gen - 1) { this.resources.delete(token); this.resourceIndex.delete(entry.indexKey); }
    this.resourceBytes = 0;
    for (const [token, item] of this.resourceCache) if (!this.resources.has(token)) { this.resourceCache.delete(token); this.cacheBytes -= item.body.length; }
    this.mainState = "none";
    this.focusState = { editable: false, inputType: "", rect: null };
  }

  frameKey(frame) {
    if (frame.key !== null && frame.key !== undefined) return frame.key;
    const isMain = !frame.parentFrameId;
    frame.key = isMain ? 0 : this.nextKey++;
    this.keyToFrame.set(frame.key, frame.frameId);
    return frame.key;
  }

  inActiveTree(frame) { const session = this.activeSession(); return Boolean(session) && frame.pageSessionId === session; }

  async startFrame(frame) {
    if (!frame.contextId || frame.started || !this.inActiveTree(frame)) return;
    const isMain = !frame.parentFrameId;
    const mirror = this.wantsMirror;
    if (isMain) {
      if (!this.mirrorable(frame.url)) { this.blank(frame.url); return; }
      this.mainState = "live";
      this.frameKey(frame);
    }
    frame.started = true;
    await this.send("Runtime.evaluate", { expression: `globalThis.__cgm && globalThis.__cgm.start(${JSON.stringify(mirror ? "mirror" : "focus")})`, contextId: frame.contextId }, frame.sessionId).catch(() => { frame.started = false; });
  }

  async ownerOf(frame) {
    const parent = this.frames.get(frame.parentFrameId);
    if (!parent?.contextId || parent.key === null || parent.key === undefined) return null;
    const { backendNodeId } = await this.send("DOM.getFrameOwner", { frameId: frame.frameId }, parent.sessionId);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId, executionContextId: parent.contextId }, parent.sessionId);
    const { result } = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){return globalThis.__cgm.idOf(this)}", returnByValue: true }, parent.sessionId);
    return Number.isInteger(result?.value) ? { f: parent.key, i: result.value } : null;
  }

  async onEvent(method, params, sessionId) {
    if (method === "__closed") {
      this.cdp = null;
      if (!this.closed && this.subscribers.size) { this.broadcast({ t: "reconnecting" }); this.reconnectTimer = setTimeout(() => void this.connect(), 500); }
      return;
    }
    switch (method) {
      case "Target.targetCreated": if (params.targetInfo?.type === "page") await this.attach(params.targetInfo); return;
      case "Target.targetInfoChanged": {
        const target = this.targets.get(params.targetInfo?.targetId);
        if (target) { target.url = params.targetInfo.url; this.chooseActive(); }
        return;
      }
      case "Target.targetDestroyed": case "Target.detachedFromTarget": {
        const targetId = params.targetId || this.sessions.get(params.sessionId)?.targetId;
        if (params.sessionId) {
          const info = this.sessions.get(params.sessionId);
          this.sessions.delete(params.sessionId);
          if (info?.type === "iframe") return;
        }
        if (targetId && this.targets.has(targetId)) {
          const target = this.targets.get(targetId);
          this.targets.delete(targetId);
          for (const [frameId, frame] of this.frames) if (frame.pageSessionId === target.sessionId) this.frames.delete(frameId);
          if (this.activeTargetId === targetId) { this.activeTargetId = null; this.chooseActive(); }
        }
        return;
      }
      case "Target.attachedToTarget": {
        // Out-of-process iframes (site isolation) of an attached page.
        if (params.targetInfo?.type !== "iframe") return;
        const parent = this.sessions.get(sessionId);
        if (!parent) return;
        this.sessions.set(params.sessionId, { targetId: params.targetInfo.targetId, pageSessionId: parent.pageSessionId, type: "iframe" });
        await this.setupSession(params.sessionId, parent.pageSessionId).catch(() => undefined);
        await this.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => undefined);
        return;
      }
    }
    const info = this.sessions.get(sessionId);
    if (!info) return;
    switch (method) {
      case "Page.frameAttached": this.registerFrame(params.frameId, sessionId, info.pageSessionId, params.parentFrameId); return;
      case "Page.frameNavigated": {
        const frame = this.registerFrame(params.frame.id, sessionId, info.pageSessionId, params.frame.parentId, params.frame.url);
        frame.url = params.frame.url; frame.started = false;
        if (!params.frame.parentId && info.type === "page") {
          const target = this.targets.get(info.targetId);
          if (target) target.url = params.frame.url;
          if (this.inActiveTree(frame)) {
            this.newGeneration();
            if (!this.mirrorable(frame.url)) this.blank(frame.url);
            else this.broadcast({ t: "loading", g: this.gen }, "mirror");
            this.broadcast({ t: "focus", ...this.focusState }, "focus");
            // The new document's world may already have said hello.
            if (frame.contextId) await this.startFrame(frame);
          } else this.chooseActive();
        }
        return;
      }
      case "Page.navigatedWithinDocument": {
        // history.pushState/replaceState or a fragment change: same document, new URL.
        const frame = this.frames.get(params.frameId);
        if (!frame || typeof params.url !== "string") return;
        frame.url = params.url;
        if (frame.parentFrameId || info.type !== "page") return;
        const target = this.targets.get(info.targetId);
        if (target) target.url = params.url;
        if (this.inActiveTree(frame) && this.mainState === "live" && !this.mirrorable(params.url)) {
          this.newGeneration();
          frame.started = false;
          this.blank(params.url);
          void this.send("Runtime.evaluate", { expression: "globalThis.__cgm && globalThis.__cgm.stop()", contextId: frame.contextId }, frame.sessionId).catch(() => undefined);
        }
        return;
      }
      case "Page.frameDetached": if (params.reason !== "swap") this.frames.delete(params.frameId); return;
      case "Page.javascriptDialogOpening":
        if (info.pageSessionId === this.activeSession()) {
          this.dialog = { type: params.type, message: String(params.message || "").slice(0, 2000) };
          this.broadcast({ t: "jsdialog", ...this.dialog }, "mirror");
        }
        return;
      case "Page.javascriptDialogClosed": this.dialog = null; this.broadcast({ t: "jsdialog-closed" }, "mirror"); return;
      case "Runtime.executionContextCreated": {
        const context = params.context;
        if (typeof context?.name === "string" && context.name !== this.world && context.name.startsWith(WORLD_PREFIX)) {
          // A previous engine's world: stop its observers and timers, never read from it.
          void this.send("Runtime.evaluate", { expression: "globalThis.__cgm && (globalThis.__cgm.stop(), 0)", contextId: context.id }, sessionId).catch(() => undefined);
          return;
        }
        if (context?.name !== this.world || !context.auxData?.frameId) return;
        const frame = this.registerFrame(context.auxData.frameId, sessionId, info.pageSessionId, undefined);
        if (frame.sessionId !== sessionId) return;
        frame.contextId = context.id; frame.started = false;
        this.contexts.set(`${sessionId}:${context.id}`, frame.frameId);
        return;
      }
      case "Runtime.executionContextDestroyed": {
        const frameId = this.contexts.get(`${sessionId}:${params.executionContextId}`);
        this.contexts.delete(`${sessionId}:${params.executionContextId}`);
        const frame = frameId && this.frames.get(frameId);
        if (frame?.contextId === params.executionContextId) { frame.contextId = null; frame.started = false; }
        return;
      }
      case "Runtime.executionContextsCleared":
        for (const [key, frameId] of this.contexts) if (key.startsWith(`${sessionId}:`)) { this.contexts.delete(key); const frame = this.frames.get(frameId); if (frame) { frame.contextId = null; frame.started = false; } }
        return;
      case "Runtime.bindingCalled": {
        if (params.name !== BINDING) return;
        const frameId = this.contexts.get(`${sessionId}:${params.executionContextId}`);
        const frame = frameId && this.frames.get(frameId);
        if (!frame || typeof params.payload !== "string") return;
        if (params.payload.length > MIRROR_LIMITS.maxMessageBytes) { this.fallback("size"); return; }
        let message; try { message = JSON.parse(params.payload); } catch { return; }
        await this.onCapture(frame, message, params.payload.length);
        return;
      }
    }
  }

  /** The top-level page must not be shown (landed Canvas, error or disallowed page). */
  blank(url) {
    this.mainState = "blank";
    this.blankLanded = Boolean(safeCall(() => this.landed(url)));
    this.broadcast(this.blankMessage(), "mirror");
  }
  blankMessage() { return this.blankLanded ? { t: "blank", g: this.gen, landed: 1 } : { t: "blank", g: this.gen }; }

  /** Same-origin rule: only frames whose effective origin equals the top-level page's are mirrored. */
  frameAllowed(frame) {
    const chain = [];
    for (let current = frame, depth = 0; current && depth < 16; current = this.frames.get(current.parentFrameId), depth += 1) {
      chain.unshift(current);
      if (!current.parentFrameId) break;
    }
    if (!chain.length || chain[0].parentFrameId) return false; // detached from the main frame
    const top = frameOrigin(chain[0].url);
    if (!top) return false;
    let origin = top;
    for (const item of chain.slice(1)) {
      origin = frameOrigin(item.url, origin);
      if (origin !== top) return false;
    }
    return true;
  }

  fallback(reason) {
    if (this.fallbackGen === this.gen) return;
    this.fallbackGen = this.gen;
    this.log({ event: "mirror_fallback", reason });
    this.broadcast({ t: "fallback", g: this.gen, reason }, "mirror");
  }

  rewriterFor(frame, gen) {
    return (absolute, kind) => {
      let host;
      try { const url = new URL(absolute); if (url.protocol !== "https:" || url.port) return null; host = url.hostname; } catch { return null; }
      if (!this.resourceHostAllowed(host)) return null;
      const indexKey = `${kind}|${frame.frameId}|${absolute}`;
      const existing = this.resourceIndex.get(indexKey);
      if (existing && this.resources.has(existing)) return `${this.prefix}r/${existing}`;
      let count = 0; for (const entry of this.resources.values()) if (entry.gen === gen) count += 1;
      if (count >= MIRROR_LIMITS.maxResourcesPerDocument) return null;
      const token = randomBytes(18).toString("base64url");
      this.resources.set(token, { url: absolute, kind, frameId: frame.frameId, gen, indexKey });
      this.resourceIndex.set(indexKey, token);
      // Warm the cache before the viewer asks: its request then costs one network round
      // trip instead of a round trip plus a remote-browser fetch (CSS -> fonts is a chain).
      if (kind === "css") queueMicrotask(() => { void this.resource(token).catch(() => undefined); });
      else if (PREFETCH_FONT.test(absolute)) queueMicrotask(() => { void this.resource(token, { cacheOnly: true }).catch(() => undefined); });
      return `${this.prefix}r/${token}`;
    };
  }

  async onCapture(frame, message, bytes) {
    if (message.t === "hello") { if (this.inActiveTree(frame)) await this.startFrame(frame); return; }
    if (!this.inActiveTree(frame) || !frame.started) return;
    const isMain = !frame.parentFrameId;
    if (message.t === "focus") { await this.onFocus(frame, message); return; }
    if (!this.wantsMirror || this.mainState !== "live") return;
    // Cross-origin iframe contents never reach a viewer (the parent's summary
    // switches the page to the pixel view when such a frame is visible).
    if (!isMain && !this.frameAllowed(frame)) return;
    // Defence in depth: the document itself says where it is; never mirror a landed/disallowed page.
    if (isMain && message.t === "doc" && typeof message.url === "string" && !this.mirrorable(message.url)) { this.blank(message.url); return; }
    const gen = this.gen;
    if (!isMain && !frame.owner) {
      if (message.t !== "doc") return; // Mutations before the owner is known are covered by the next snapshot.
      const parent = this.frames.get(frame.parentFrameId);
      if (!parent || parent.key === null || parent.key === undefined) return;
      frame.owner = await this.ownerOf(frame).catch(() => null);
      if (!frame.owner || gen !== this.gen) return;
      this.frameKey(frame);
    }
    const key = this.frameKey(frame);
    const ctx = { base: typeof message.base === "string" ? message.base : frame.url, rewrite: this.rewriterFor(frame, gen) };
    switch (message.t) {
      case "doc": {
        if (bytes > MIRROR_LIMITS.maxSnapshotBytes) { this.fallback("size"); return; }
        frame.base = ctx.base;
        let root;
        try { root = sanitizeTree(message.root, ctx); }
        catch (error) { this.fallback(error instanceof MirrorLimitError ? error.reason : "error"); return; }
        if (!root) { this.fallback("error"); return; }
        const adopted = Array.isArray(message.adopted) ? message.adopted.slice(0, 50).map((css) => rewriteCss(String(css), ctx.base, ctx.rewrite)) : [];
        const out = { t: "doc", g: gen, f: key, owner: frame.owner || null, quirks: message.quirks === true, root, adopted,
          scroll: { x: Number(message.scroll?.x) || 0, y: Number(message.scroll?.y) || 0 }, focus: Number.isInteger(message.focus) ? message.focus : 0 };
        if (isMain) this.lastMainDoc = out;
        this.broadcast(out, "mirror");
        if (!isMain && detectFallback({ frames: [frame.url] }) === "captcha") this.fallback("captcha");
        return;
      }
      case "mut": {
        frame.base = frame.base || ctx.base;
        let clean;
        try { clean = sanitizeMutation(message, { ...ctx, base: frame.base }); }
        catch (error) { this.fallback(error instanceof MirrorLimitError ? error.reason : "error"); return; }
        this.broadcast({ t: "mut", g: gen, f: key, ...clean }, "mirror");
        return;
      }
      case "css": if (Number.isInteger(message.i)) this.broadcast({ t: "css", g: gen, f: key, i: message.i, css: rewriteCss(String(message.css ?? ""), frame.base || ctx.base, ctx.rewrite) }, "mirror"); return;
      case "adopted": this.broadcast({ t: "adopted", g: gen, f: key, i: 0, css: (Array.isArray(message.css) ? message.css : []).slice(0, 50).map((css) => rewriteCss(String(css), frame.base || ctx.base, ctx.rewrite)) }, "mirror"); return;
      case "val": {
        if (!Number.isInteger(message.i)) return;
        const out = { t: "val", g: gen, f: key, i: message.i };
        if (typeof message.v === "string") out.v = message.v.slice(0, MIRROR_LIMITS.maxInputValue);
        if (typeof message.ck === "boolean") out.ck = message.ck;
        if (message.pw === 0 || message.pw === 1) out.pw = message.pw;
        this.broadcast(out, "mirror");
        return;
      }
      case "scroll": if (Number.isInteger(message.i)) this.broadcast({ t: "scroll", g: gen, f: key, i: message.i, x: Number(message.x) || 0, y: Number(message.y) || 0 }, "mirror"); return;
      case "dialog": if (Number.isInteger(message.i)) this.broadcast({ t: "dialog", g: gen, f: key, i: message.i, open: message.open === true, md: message.md === 1 ? 1 : 0 }, "mirror"); return;
      case "canvas": if (Number.isInteger(message.i) && safeCanvasData(message.cv)) this.broadcast({ t: "canvas", g: gen, f: key, i: message.i, cv: message.cv }, "mirror"); return;
      case "summary": { const reason = detectFallback(message); if (reason) this.fallback(reason); return; }
      case "error": this.fallback(message.reason === "size" ? "size" : "error"); return;
    }
  }

  async onFocus(frame, message) {
    if (message.inputType === "frame") return; // the child frame reports its own focus
    let rect = null;
    if (message.editable && Number.isInteger(message.i) && message.i > 0) {
      try {
        const objectId = await this.objectFor(frame, message.i);
        const { quads } = await this.send("DOM.getContentQuads", { objectId }, frame.sessionId);
        const metrics = await this.send("Page.getLayoutMetrics", {}, frame.pageSessionId);
        const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport;
        const quad = quads?.[0];
        if (quad && viewport?.clientWidth > 0 && viewport?.clientHeight > 0) {
          const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
          const round = (value) => Math.round(value * 10_000) / 10_000;
          rect = { x: round(Math.min(...xs) / viewport.clientWidth), y: round(Math.min(...ys) / viewport.clientHeight),
            w: round((Math.max(...xs) - Math.min(...xs)) / viewport.clientWidth), h: round((Math.max(...ys) - Math.min(...ys)) / viewport.clientHeight) };
        }
      } catch { /* element vanished */ }
    }
    this.focusState = { editable: message.editable === true, inputType: String(message.inputType || "").slice(0, 24), rect };
    this.broadcast({ t: "focus", ...this.focusState }, "focus");
    if (this.wantsMirror && frame.key !== null && frame.key !== undefined && Number.isInteger(message.i)) this.broadcast({ t: "rfocus", g: this.gen, f: frame.key, i: message.i }, "mirror");
  }

  async resendAll(subscriber) {
    subscriber.send({ t: "reset", g: this.gen });
    if (this.mainState === "blank") { subscriber.send(this.blankMessage()); return; }
    if (this.fallbackGen === this.gen) subscriber.send({ t: "fallback", g: this.gen, reason: "repeat" });
    // Re-snapshot every started frame of the active page so the new subscriber gets a full picture.
    for (const frame of this.frames.values()) {
      if (!this.inActiveTree(frame) || !frame.contextId) continue;
      if (!frame.started) { await this.startFrame(frame); continue; }
      await this.send("Runtime.evaluate", { expression: "globalThis.__cgm && (globalThis.__cgm.start('mirror'), 0)", contextId: frame.contextId }, frame.sessionId).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Subresources: served from the remote browser's own cache, or loaded by the
  // remote browser itself (same egress proxy and policy). Never fetched from here.

  resource(token, { cacheOnly = false } = {}) {
    const inflight = this.resourceInflight.get(token);
    // A real request that meets a cache-only prefetch falls through to a full load on a miss.
    if (inflight) return cacheOnly ? inflight.promise : inflight.promise.then((item) => item || (inflight.cacheOnly ? this.resource(token) : item));
    const promise = this.loadResource(token, cacheOnly).finally(() => { if (this.resourceInflight.get(token)?.promise === promise) this.resourceInflight.delete(token); });
    this.resourceInflight.set(token, { promise, cacheOnly });
    return promise;
  }

  async loadResource(token, cacheOnly = false) {
    const entry = this.resources.get(token);
    if (!entry) return null;
    const cached = this.resourceCache.get(token);
    if (cached) return cached;
    const frame = this.frames.get(entry.frameId) || this.pageFrame(this.activeSession());
    if (!frame) return null;
    let body = await this.remoteBytes(frame, entry.url, cacheOnly).catch(() => null);
    if (!body) return null;
    if (body.length > MIRROR_LIMITS.maxResourceBytes || this.resourceBytes + body.length > MIRROR_LIMITS.maxResourceBytesPerDocument) return { status: 413 };
    this.resourceBytes += body.length;
    let type;
    if (entry.kind === "css") {
      const css = rewriteCss(body.toString("utf8"), entry.url, this.rewriterFor(frame, entry.gen));
      body = Buffer.from(css, "utf8"); type = "text/css; charset=utf-8";
    } else {
      type = sniffMedia(body);
      if (!type) return { status: 415 };
    }
    const item = { body, type };
    if (this.cacheBytes + body.length < 40 * 1024 * 1024) { this.resourceCache.set(token, item); this.cacheBytes += body.length; }
    return item;
  }

  async remoteBytes(frame, url, cacheOnly = false) {
    try {
      const { content, base64Encoded } = await this.send("Page.getResourceContent", { frameId: frame.frameId, url }, frame.sessionId);
      if (typeof content === "string" && content.length) return Buffer.from(content, base64Encoded ? "base64" : "utf8");
    } catch { /* not in the remote cache: load it through the remote browser */ }
    if (cacheOnly) return null;
    const { resource } = await this.send("Network.loadNetworkResource", { frameId: frame.frameId, url, options: { disableCache: false, includeCredentials: true } }, frame.sessionId);
    if (!resource?.success || !resource.stream || (resource.httpStatusCode && resource.httpStatusCode >= 400)) {
      if (resource?.stream) await this.send("IO.close", { handle: resource.stream }, frame.sessionId).catch(() => undefined);
      return null;
    }
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const chunk = await this.send("IO.read", { handle: resource.stream, size: 256 * 1024 }, frame.sessionId);
        if (chunk.data) { const part = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"); size += part.length; if (size > MIRROR_LIMITS.maxResourceBytes) return Buffer.alloc(MIRROR_LIMITS.maxResourceBytes + 1); chunks.push(part); }
        if (chunk.eof) break;
      }
    } finally { await this.send("IO.close", { handle: resource.stream }, frame.sessionId).catch(() => undefined); }
    return Buffer.concat(chunks);
  }

  // -------------------------------------------------------------------------
  // Input replay. Only node ids the capture script assigned in the CURRENT
  // generation are addressable; no arbitrary CDP is reachable from a viewer.

  async objectFor(frame, id) {
    const { result } = await this.send("Runtime.evaluate", { expression: `globalThis.__cgm ? globalThis.__cgm.node(${Number(id)}) : null`, contextId: frame.contextId }, frame.sessionId);
    if (!result?.objectId || result.subtype !== "node") throw Object.assign(new Error("missing"), { missing: true });
    return result.objectId;
  }

  async call(frame, objectId, fn, args = []) {
    const { result } = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true }, frame.sessionId);
    return result?.value;
  }

  async applyViewport() {
    const session = this.activeSession();
    if (!session) return;
    if (this.colorScheme) await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: this.colorScheme }] }, session).catch(() => undefined);
    if (this.pixels || !this.viewport || !this.wantsMirror) { await this.send("Emulation.clearDeviceMetricsOverride", {}, session).catch(() => undefined); return; }
    await this.send("Emulation.setDeviceMetricsOverride", { width: this.viewport.w, height: this.viewport.h, deviceScaleFactor: 0, mobile: this.display.mobile === true }, session).catch(() => undefined);
  }

  async key(pageSession, key, shift) {
    const codes = { Enter: [13, "\r"], Escape: [27, ""], Tab: [9, ""] };
    const [code, text] = codes[key];
    const modifiers = shift ? 8 : 0;
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: text || undefined, unmodifiedText: text || undefined, modifiers }, pageSession);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers }, pageSession);
  }

  async input(message) {
    if (!this.cdp) return { ok: false, code: "UNAVAILABLE" };
    if (message.t === "viewport") { this.viewport = { w: message.w, h: message.h }; if (message.cs) this.colorScheme = message.cs; await this.applyViewport(); return { ok: true }; }
    if (message.t === "renderer") { this.pixels = message.r === "pixels"; await this.applyViewport(); return { ok: true }; }
    const pageSession = this.activeSession();
    if (!pageSession) return { ok: false, code: "UNAVAILABLE" };
    if (message.t === "jsdialog") { await this.send("Page.handleJavaScriptDialog", { accept: message.accept }, pageSession).catch(() => undefined); return { ok: true }; }
    if (message.g !== this.gen) return { ok: false, code: "STALE" };
    const frameId = this.keyToFrame.get(message.f);
    const frame = frameId && this.frames.get(frameId);
    if (!frame?.contextId || !frame.started) return { ok: false, code: "STALE" };
    if (message.t === "key" && !message.i) { await this.key(pageSession, message.k, message.shift); return { ok: true }; }
    if (message.t === "scroll" && message.i === 0) {
      await this.send("Runtime.evaluate", { expression: `scrollTo(${message.x}, ${message.y})`, contextId: frame.contextId }, frame.sessionId).catch(() => undefined);
      return { ok: true };
    }
    let objectId;
    try { objectId = await this.objectFor(frame, message.i); } catch { return { ok: false, code: "MISSING" }; }
    switch (message.t) {
      case "click": {
        await this.send("DOM.scrollIntoViewIfNeeded", { objectId }, frame.sessionId).catch(() => undefined);
        const { quads } = await this.send("DOM.getContentQuads", { objectId }, frame.sessionId);
        let point = clickPoint(quads?.[0], message.ox, message.oy);
        if (!point) return { ok: false, code: "NOT_VISIBLE" };
        if (frame.sessionId !== pageSession) point = await this.translateOutOfProcess(frame, point);
        if (!point) return { ok: false, code: "NOT_VISIBLE" };
        const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, pageSession);
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 }, pageSession);
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 }, pageSession);
        return { ok: true };
      }
      case "focus": await this.send("DOM.focus", { objectId }, frame.sessionId).catch(() => undefined); return { ok: true };
      case "scroll": await this.call(frame, objectId, "function(x,y){this.scrollTo(x,y)}", [message.x, message.y]).catch(() => undefined); return { ok: true };
      case "select": {
        await this.call(frame, objectId, "function(v){if(this.localName!=='select')return;this.value=v;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}", [message.v]);
        return { ok: true };
      }
      case "key": {
        await this.send("DOM.focus", { objectId }, frame.sessionId).catch(() => undefined);
        await this.key(pageSession, message.k, message.shift);
        return { ok: true };
      }
      case "input": {
        const state = await this.call(frame, objectId, INPUT_STATE_FN);
        if (!state || state.ro) return { ok: false, code: "NOT_EDITABLE" };
        await this.send("DOM.focus", { objectId }, frame.sessionId).catch(() => undefined);
        const password = state.secret === true || state.type === "password";
        if (VALUE_TYPES.has(state.type) && !password) {
          await this.call(frame, objectId, "function(v){this.value=v;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}", [message.v]);
          return { ok: true, v: message.v };
        }
        // Secret (password / one-time code) values never leave the remote browser, so such an edit always replaces the whole value.
        const plan = password ? (message.v === "" && state.len === 0 ? null : { start: 0, end: state.len, text: message.v, all: true }) : planTextEdit(state.value, message.v, supportsSelection(state.tag, state.type));
        if (!plan) return { ok: true, ...(password ? {} : { v: state.value }) };
        await this.call(frame, objectId, "function(s,e,all){try{if(all){this.select();}else{this.setSelectionRange(s,e);}}catch(_){this.select&&this.select();}}", [plan.start, plan.end, plan.all === true]);
        if (plan.text) await this.send("Input.insertText", { text: plan.text }, pageSession);
        else if (plan.end > plan.start || plan.all) {
          await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, pageSession);
          await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, pageSession);
        }
        if (password) return { ok: true };
        const value = await this.call(frame, objectId, "function(){return this.value}");
        return { ok: true, v: typeof value === "string" ? value.slice(0, MIRROR_LIMITS.maxInputValue) : undefined };
      }
    }
    return { ok: false, code: "UNSUPPORTED" };
  }

  /** Add the owner-iframe offsets of an out-of-process frame chain to a point. */
  async translateOutOfProcess(frame, point) {
    let current = frame, x = point.x, y = point.y;
    for (let depth = 0; depth < 8 && current.parentFrameId; depth += 1) {
      const parent = this.frames.get(current.parentFrameId);
      if (!parent) return null;
      if (parent.sessionId === current.sessionId) { current = parent; continue; }
      const { backendNodeId } = await this.send("DOM.getFrameOwner", { frameId: current.frameId }, parent.sessionId);
      const { model } = await this.send("DOM.getBoxModel", { backendNodeId }, parent.sessionId);
      x += model.content[0]; y += model.content[1];
      current = parent;
    }
    return { x, y };
  }
}
