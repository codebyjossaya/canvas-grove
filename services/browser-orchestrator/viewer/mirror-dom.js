// Builds and updates one mirrored document inside a sandboxed, script-less
// iframe document. Every tag, attribute and stylesheet is re-validated with
// the client checks in mirror-protocol.js before it touches the DOM, so a
// server-side sanitizer bug cannot become script execution here (and the
// frame's sandbox and CSP would still refuse to run it).
import { clientAttrAllowed, clientCssAllowed, clientTagAllowed, NAMESPACES, safeCanvasData, svgTagName } from "./mirror-protocol.js";

const XLINK_NS = "http://www.w3.org/1999/xlink";
// Inserted first so every page rule wins the cascade; :where() keeps specificity at zero.
export const MIRROR_BASE_CSS = ":where([data-cgm-link]){cursor:pointer}";

export class MirrorFrame {
  /**
   * @param {Document} doc  the (sandboxed) document to render into
   * @param {{ onFrameElement?: (element: Element, id: number) => void }} hooks
   */
  constructor(doc, hooks = {}) {
    this.doc = doc;
    this.hooks = hooks;
    this.nodes = new Map();
    this.meta = new WeakMap();
    this.after = [];
    this.adopted = null;
  }

  register(node, id, meta) {
    this.nodes.set(id, node);
    this.meta.set(node, { id, ...meta });
  }
  idOf(node) { return this.meta.get(node)?.id ?? 0; }
  infoOf(node) { return this.meta.get(node); }

  unregister(node) {
    const meta = this.meta.get(node);
    if (meta && this.nodes.get(meta.id) === node) this.nodes.delete(meta.id);
    for (let child = node.firstChild; child; child = child.nextSibling) this.unregister(child);
    if (meta?.shadow) this.unregister(meta.shadow);
  }

  setAttribute(element, tag, ns, name, value) {
    if (!clientAttrAllowed(tag, ns, name, value)) return false;
    if (name === "xlink:href") element.setAttributeNS(XLINK_NS, name, value);
    else element.setAttribute(name, value);
    return true;
  }

  build(data) {
    if (!data || typeof data !== "object" || !Number.isInteger(data.i)) return null;
    const doc = this.doc;
    if (data.t === 3) {
      const text = doc.createTextNode(typeof data.x === "string" ? data.x : "");
      this.register(text, data.i, { text: true });
      return text;
    }
    if (data.t !== 1 || !clientTagAllowed(data.n, data.ns)) return null;
    const ns = data.ns === "svg" ? "svg" : "html";
    const tag = data.n;
    let element;
    if (ns === "svg") element = doc.createElementNS(NAMESPACES.svg, svgTagName(tag));
    else if (tag === "canvas") element = doc.createElement("img"); // bitmap snapshot of a remote canvas
    else element = doc.createElement(tag);
    this.register(element, data.i, { tag, ns });
    for (const pair of Array.isArray(data.a) ? data.a : []) if (Array.isArray(pair)) this.setAttribute(element, tag, ns, String(pair[0]), String(pair[1]));
    if (data.lk === 1 && (tag === "a" || tag === "area")) {
      // A same-document fragment keeps :link styling; clicks are intercepted
      // and replayed remotely, and the sandbox forbids navigation and popups.
      element.setAttribute("href", "#");
      element.setAttribute("data-cgm-link", "");
    }
    if (tag === "style") { element.textContent = clientCssAllowed(data.css) ? data.css : ""; return element; }
    if (tag === "canvas") { if (safeCanvasData(data.cv)) element.setAttribute("src", data.cv); element.setAttribute("data-cgm-canvas", ""); return element; }
    if (tag === "iframe") {
      element.setAttribute("sandbox", "allow-same-origin");
      element.removeAttribute("src");
      this.after.push(() => this.hooks.onFrameElement?.(element, data.i));
      return element;
    }
    if (tag === "textarea") { element.value = typeof data.v === "string" ? data.v : ""; return element; }
    for (const child of Array.isArray(data.c) ? data.c : []) {
      const built = this.build(child);
      if (built) element.appendChild(built);
    }
    if (tag === "input") {
      if (typeof data.v === "string") element.value = data.v;
      if (typeof data.ck === "boolean") element.checked = data.ck;
    }
    if (tag === "select" && typeof data.v === "string") element.value = data.v;
    if (data.sr && Number.isInteger(data.sr.i) && typeof element.attachShadow === "function") {
      try {
        const root = element.attachShadow({ mode: "open" });
        this.register(root, data.sr.i, { shadowRoot: true });
        this.meta.get(element).shadow = root;
        for (const sheet of Array.isArray(data.sr.css) ? data.sr.css : []) {
          if (!clientCssAllowed(sheet)) continue;
          const style = doc.createElement("style"); style.textContent = sheet; style.setAttribute("data-cgm-adopted", ""); root.appendChild(style);
        }
        for (const child of Array.isArray(data.sr.c) ? data.sr.c : []) { const built = this.build(child); if (built) root.appendChild(built); }
      } catch { /* element cannot host a shadow root locally */ }
    }
    if (tag === "dialog" && data.md === 1) this.after.push(() => this.dialog(data.i, true, 1));
    return element;
  }

  runAfter() {
    const queue = this.after; this.after = [];
    for (const task of queue) { try { task(); } catch { /* best effort */ } }
  }

  /** Replace the whole document with a snapshot. */
  load(message) {
    const doc = this.doc;
    for (const node of this.nodes.values()) this.meta.delete(node);
    this.nodes.clear();
    const root = this.build(message.root);
    let html = root;
    if (!root || root.nodeType !== 1 || root.localName !== "html") {
      html = doc.createElement("html");
      html.appendChild(doc.createElement("head"));
      const body = doc.createElement("body");
      if (root) body.appendChild(root);
      html.appendChild(body);
    }
    let head = null;
    for (let child = html.firstChild; child; child = child.nextSibling) if (child.localName === "head") { head = child; break; }
    if (!head) { head = doc.createElement("head"); html.insertBefore(head, html.firstChild); }
    const base = doc.createElement("style");
    base.setAttribute("data-cgm-internal", "");
    base.textContent = MIRROR_BASE_CSS;
    head.insertBefore(base, head.firstChild);
    this.head = head;
    this.adopted = null;
    if (doc.documentElement) doc.replaceChild(html, doc.documentElement); else doc.appendChild(html);
    this.setAdopted(0, message.adopted);
    this.runAfter();
    return html;
  }

  setAdopted(id, sheets) {
    const list = Array.isArray(sheets) ? sheets.filter(clientCssAllowed) : [];
    if (id === 0) {
      if (!this.head) return;
      if (!this.adopted) {
        if (!list.length) return;
        this.adopted = this.doc.createElement("style");
        this.adopted.setAttribute("data-cgm-adopted", "");
      }
      this.adopted.textContent = list.join("\n");
      this.head.appendChild(this.adopted);
    }
  }

  /** Keep the document-level adopted sheet last, as adoptedStyleSheets are in the cascade. */
  keepAdoptedLast() {
    if (this.adopted && this.head && this.head.lastChild !== this.adopted) this.head.appendChild(this.adopted);
  }

  applyMutation(message) {
    for (const id of Array.isArray(message.rems) ? message.rems : []) {
      const node = this.nodes.get(id);
      if (!node) continue;
      this.unregister(node);
      node.parentNode?.removeChild(node);
    }
    for (const add of Array.isArray(message.adds) ? message.adds : []) {
      const parent = this.nodes.get(add.p);
      if (!parent || !add.node) continue;
      const parentInfo = this.meta.get(parent);
      if (parentInfo?.text || parentInfo?.tag === "style" || parentInfo?.tag === "textarea" || parentInfo?.tag === "iframe" || parentInfo?.tag === "canvas") continue;
      const existing = this.nodes.get(add.node.i);
      if (existing) { this.unregister(existing); existing.parentNode?.removeChild(existing); }
      const built = this.build(add.node);
      if (!built) continue;
      const before = Number.isInteger(add.b) ? this.nodes.get(add.b) : null;
      if (before && before.parentNode === parent) parent.insertBefore(built, before);
      else parent.appendChild(built);
    }
    for (const change of Array.isArray(message.attrs) ? message.attrs : []) {
      const element = this.nodes.get(change.i);
      const info = element && this.meta.get(element);
      if (!info || info.text || info.shadowRoot || typeof change.n !== "string") continue;
      if (change.n === "href" && (info.tag === "a" || info.tag === "area")) continue; // fixed to "#"
      if (info.tag === "iframe" && (change.n === "src" || change.n === "sandbox")) continue;
      if (change.v === null || change.v === undefined) { try { element.removeAttribute(change.n); } catch { /* invalid name */ } continue; }
      if (!this.setAttribute(element, info.tag, info.ns, change.n, String(change.v))) { try { element.removeAttribute(change.n); } catch { /* invalid name */ } }
    }
    for (const text of Array.isArray(message.texts) ? message.texts : []) {
      const node = this.nodes.get(text.i);
      if (node && this.meta.get(node)?.text && typeof text.x === "string") node.data = text.x;
    }
    this.keepAdoptedLast();
    this.runAfter();
  }

  setCss(id, css) {
    const element = this.nodes.get(id);
    if (element && this.meta.get(element)?.tag === "style") element.textContent = clientCssAllowed(css) ? css : "";
  }

  setValue(id, message, { force = false } = {}) {
    const element = this.nodes.get(id);
    const info = element && this.meta.get(element);
    if (!info || !["input", "textarea", "select"].includes(info.tag)) return false;
    let changed = false;
    if (typeof message.v === "string" && (force || element.value !== message.v)) { element.value = message.v; changed = true; }
    if (typeof message.ck === "boolean" && element.checked !== message.ck) { element.checked = message.ck; changed = true; }
    if (message.pw === 0 && element.value !== "") { element.value = ""; changed = true; }
    return changed;
  }

  setCanvas(id, data) {
    const element = this.nodes.get(id);
    if (element && this.meta.get(element)?.tag === "canvas" && safeCanvasData(data)) element.setAttribute("src", data);
  }

  dialog(id, open, modal) {
    const element = this.nodes.get(id);
    if (!element || this.meta.get(element)?.tag !== "dialog") return;
    try {
      if (!open) { if (element.open) element.close(); return; }
      if (modal) { if (element.open) element.close(); element.showModal(); }
      else if (!element.open) element.show();
    } catch { /* not connected yet */ }
  }
}
