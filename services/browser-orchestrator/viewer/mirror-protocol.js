// DOM-mirror protocol: pure, dependency-free helpers shared by the orchestrator
// (server-side sanitization and URL rewriting) and the viewer (client-side
// re-validation before any element is created). Imported directly by node:test.
//
// Threat model: every tag, attribute, text and URL in a serialized node comes
// from the remote page and is attacker controlled. Nothing here ever produces
// executable content: scripts, event-handler attributes, javascript:/vbscript:
// URLs, srcdoc, <base>, <meta http-equiv>, form actions, plugins and
// navigable links are removed, and every subresource URL is replaced by an
// opaque same-origin proxy token (or dropped).

export const MIRROR_LIMITS = Object.freeze({
  maxNodes: 30_000,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxMessageBytes: 6 * 1024 * 1024,
  maxDepth: 256,
  maxAttrValue: 64 * 1024,
  maxText: 512 * 1024,
  maxCss: 2 * 1024 * 1024,
  maxResourceBytes: 5 * 1024 * 1024,
  maxResourceBytesPerDocument: 60 * 1024 * 1024,
  maxResourcesPerDocument: 600,
  maxInputValue: 8 * 1024,
  maxInputBody: 16 * 1024,
  inputRatePerSecond: 40,
  maxCanvasDataUrl: 768 * 1024,
});

const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";
export const NAMESPACES = Object.freeze({ html: HTML_NS, svg: SVG_NS });

// Removed together with their whole subtree.
export const DROP_SUBTREE_TAGS = new Set([
  "script", "noscript", "template", "object", "embed", "applet", "frame", "frameset", "noframes", "noembed",
  "base", "meta", "title", "param", "audio", "video", "track", "portal", "xmp", "plaintext", "math",
  "foreignobject", "animate", "set", "animatemotion", "animatetransform", "handler", "listener", "iframe-srcdoc",
]);

export const HTML_TAGS = new Set([
  "html", "head", "body", "a", "abbr", "address", "area", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br",
  "button", "canvas", "caption", "center", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details",
  "dfn", "dialog", "div", "dl", "dt", "em", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hgroup", "hr", "i", "iframe", "img", "input", "ins", "kbd", "label", "legend", "li", "link",
  "main", "map", "mark", "menu", "meter", "nav", "nobr", "ol", "optgroup", "option", "output", "p", "picture", "pre",
  "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section", "select", "slot", "small", "source", "span",
  "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "textarea", "tfoot", "th", "thead",
  "time", "tr", "tt", "u", "ul", "var", "wbr",
]);

export const SVG_TAGS = new Set([
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "text", "tspan", "textpath", "defs",
  "symbol", "use", "clippath", "mask", "lineargradient", "radialgradient", "stop", "pattern", "image", "title", "desc",
  "marker", "filter", "style", "view", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "fecomposite", "feflood",
  "femerge", "femergenode", "femorphology", "fedropshadow", "feturbulence", "fedisplacementmap", "fecomponenttransfer",
  "fefunca", "fefuncr", "fefuncg", "fefuncb",
]);

// SVG element names are case sensitive when created with createElementNS.
const SVG_CASE = new Map(["textPath", "clipPath", "linearGradient", "radialGradient", "feGaussianBlur", "feOffset", "feBlend",
  "feColorMatrix", "feComposite", "feFlood", "feMerge", "feMergeNode", "feMorphology", "feDropShadow", "feTurbulence",
  "feDisplacementMap", "feComponentTransfer", "feFuncA", "feFuncR", "feFuncG", "feFuncB"].map((name) => [name.toLowerCase(), name]));
export const svgTagName = (lower) => SVG_CASE.get(lower) || lower;

const CUSTOM_ELEMENT = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

const HTML_GLOBAL_ATTRS = new Set([
  "id", "class", "style", "title", "lang", "dir", "hidden", "tabindex", "role", "translate", "accesskey", "inert",
  "draggable", "spellcheck", "slot", "part", "exportparts", "inputmode", "enterkeyhint", "autocapitalize", "autocorrect",
]);
const HTML_ATTRS = new Set([
  "alt", "width", "height", "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "colspan", "rowspan",
  "headers", "scope", "span", "nowrap", "type", "name", "value", "placeholder", "autocomplete", "maxlength", "minlength",
  "size", "readonly", "disabled", "checked", "selected", "multiple", "required", "pattern", "min", "max", "step", "for",
  "label", "open", "start", "reversed", "list", "cols", "rows", "wrap", "dirname", "datetime", "high", "low", "optimum",
  "color", "face", "src", "srcset", "sizes", "loading", "decoding", "media", "href", "rel", "accept", "novalidate",
  "background", "clear", "noshade", "compact", "summary", "abbr", "axis", "char", "charoff", "frame", "rules",
]);
const SVG_ATTRS = new Set([
  "id", "class", "style", "role", "tabindex", "lang", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "width", "height", "points", "viewbox", "preserveaspectratio", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "stroke-opacity",
  "opacity", "transform", "transform-origin", "clip-path", "clip-rule", "mask", "filter", "offset", "stop-color",
  "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod", "fx", "fy", "fr", "patternunits",
  "patterncontentunits", "patterntransform", "markerwidth", "markerheight", "refx", "refy", "orient", "markerunits",
  "text-anchor", "dominant-baseline", "alignment-baseline", "font-family", "font-size", "font-weight", "font-style",
  "letter-spacing", "dx", "dy", "rotate", "textlength", "lengthadjust", "visibility", "display", "overflow", "color",
  "vector-effect", "shape-rendering", "version", "focusable", "stddeviation", "in", "in2", "result", "mode", "operator",
  "k1", "k2", "k3", "k4", "values", "type", "flood-color", "flood-opacity", "radius", "basefrequency", "numoctaves",
  "seed", "scale", "xchannelselector", "ychannelselector", "tablevalues", "slope", "intercept", "amplitude", "exponent",
  "clippathunits", "maskunits", "maskcontentunits", "primitiveunits", "filterunits", "pathlength", "startoffset",
  "method", "spacing", "side", "path", "href", "xlink:href", "mask-type", "paint-order", "image-rendering",
]);
// SVG attribute names are case sensitive (viewBox, gradientUnits, ...).
const SVG_ATTR_CASE = new Map(["viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform", "markerWidth", "markerHeight", "refX", "refY", "markerUnits",
  "textLength", "lengthAdjust", "stdDeviation", "baseFrequency", "numOctaves", "xChannelSelector", "yChannelSelector",
  "tableValues", "clipPathUnits", "maskUnits", "maskContentUnits", "primitiveUnits", "filterUnits", "pathLength",
  "startOffset"].map((name) => [name.toLowerCase(), name]));
export const svgAttrName = (lower) => SVG_ATTR_CASE.get(lower) || lower;

const INPUT_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number", "checkbox", "radio", "submit",
  "button", "reset", "image", "date", "datetime-local", "month", "week", "time", "color", "range", "file"]);
const TEXT_ENTRY_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "week", "time"]);
const SELECTION_TYPES = new Set(["text", "search", "url", "tel", "password"]);

/** Removes ASCII whitespace/control characters browsers ignore inside URL schemes. */
const INVISIBLE_RANGES = [[0, 32], [127, 159], [173, 173], [8203, 8207], [8232, 8233], [65279, 65279]];
const squash = (value) => Array.from(String(value)).filter((char) => { const code = char.codePointAt(0); return !INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high); }).join("");
export function dangerousScheme(value) {
  return /^(?:javascript|vbscript|livescript|mocha|data|blob|filesystem|about|file|chrome|view-source|intent|jar):/i.test(squash(value));
}
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
const SAFE_DATA_FONT = /^data:(?:font\/(?:woff2?|ttf|otf|sfnt)|application\/(?:font-woff2?|x-font-(?:woff|ttf|otf|truetype|opentype)|font-sfnt|vnd\.ms-fontobject|octet-stream))[;,]/i;
export const safeDataImage = (value) => SAFE_DATA_IMAGE.test(squash(value));

export function isTextEntry(tag, type) {
  if (tag === "textarea") return true;
  return tag === "input" && TEXT_ENTRY_TYPES.has(String(type || "text").toLowerCase());
}
export function supportsSelection(tag, type) {
  if (tag === "textarea") return true;
  return tag === "input" && SELECTION_TYPES.has(String(type || "text").toLowerCase());
}

/**
 * Secret fields: passwords and one-time codes (OTP/MFA/passcodes). Their values
 * never leave the remote browser; only "empty / non-empty" is reported, exactly
 * as for passwords. mirror/capture.js carries a copy of this pattern (it is
 * injected as a standalone script); tests/mirror-protocol.test.mjs keeps the two equal.
 */
export const SECRET_FIELD_PATTERN = /one-time-code|otp|passcode|passwd|password|totp|mfa|2fa|two[-_ ]?factor|verif\w*[-_ ]?code|security[-_ ]?code|auth\w*[-_ ]?code|sms[-_ ]?code|(?:^|[^a-z])pin(?:[^a-z]|$)/i;
export function isSecretField(tag, { type, autocomplete, name, id } = {}) {
  if (tag !== "input") return false;
  const kind = String(type || "text").toLowerCase();
  if (kind === "password") return true;
  if (!TEXT_ENTRY_TYPES.has(kind) && INPUT_TYPES.has(kind)) return false;
  return [autocomplete, name, id].some((value) => typeof value === "string" && value && SECRET_FIELD_PATTERN.test(value));
}

/**
 * Effective origin of a frame URL for the mirror's same-origin rule. about:blank
 * and about:srcdoc inherit the parent's origin; anything that is not http(s)
 * (data:, blob:, chrome-error:, ...) is opaque and never equal to anything.
 */
export function frameOrigin(url, parentOrigin = null) {
  if (typeof url !== "string" || !url) return null;
  if (/^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(url)) return parentOrigin || null;
  try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null; } catch { return null; }
}

/** Resolve a possibly relative URL against a base; only http(s) results are returned. */
export function resolveHttpUrl(value, base) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (dangerousScheme(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// CSS: rewrite url() and @import, neutralize legacy script-bearing constructs.

const CSS_URL = /url\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|((?:[^)\s"'\\]|\\.)*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([^)\s;"']+))\s*\)?/gi;
const cssUnescape = (value) => value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, escape) => /^[0-9a-f]/i.test(escape) ? String.fromCodePoint(Math.min(parseInt(escape, 16) || 0xfffd, 0x10ffff)) : escape);
const cssQuote = (value) => `"${String(value).replace(/["\\\n\r]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`;

/**
 * Rewrite every url() and @import in a stylesheet. `rewrite(absoluteUrl, kind)`
 * returns a same-origin proxy path or null; null becomes an inert URL.
 */
export function rewriteCss(css, base, rewrite) {
  if (typeof css !== "string") return "";
  let text = css.length > MIRROR_LIMITS.maxCss ? css.slice(0, MIRROR_LIMITS.maxCss) : css;
  // Legacy script-bearing CSS (IE expressions, behaviors, XBL bindings).
  text = text.replace(/expression\s*\(/gi, "x-blocked(").replace(/(?:-ms-)?behavior\s*:/gi, "x-blocked:").replace(/-moz-binding\s*:/gi, "x-blocked:");
  text = text.replace(CSS_IMPORT, (_, a, b, c) => {
    const raw = cssUnescape(a ?? b ?? c ?? "");
    const absolute = resolveHttpUrl(raw, base);
    const local = absolute && rewrite(absolute, "css");
    return `@import url(${cssQuote(local || "about:invalid")})`;
  });
  text = text.replace(CSS_URL, (match, a, b, c) => {
    const raw = cssUnescape(a ?? b ?? c ?? "").trim();
    if (raw.startsWith("#")) return `url(${cssQuote(raw)})`; // SVG fragment reference
    if (raw.startsWith("/viewer/") && /\/m\/r\/[A-Za-z0-9_-]+$/.test(raw)) return `url(${cssQuote(raw)})`; // already rewritten
    if (/^data:/i.test(squash(raw))) return SAFE_DATA_IMAGE.test(squash(raw)) || SAFE_DATA_FONT.test(squash(raw)) ? `url(${cssQuote(raw)})` : 'url("about:invalid")';
    const absolute = resolveHttpUrl(raw, base);
    const local = absolute && rewrite(absolute, "media");
    return `url(${cssQuote(local || "about:invalid")})`;
  });
  return text;
}

export function rewriteSrcset(value, base, rewrite) {
  if (typeof value !== "string") return null;
  const out = [];
  for (const candidate of value.split(/,\s+|(?<=\s\d+(?:\.\d+)?[wx]),|,(?=[a-z][a-z0-9+.-]*:|\/)/i)) {
    const [url, ...descriptor] = candidate.trim().split(/\s+/);
    if (!url) continue;
    if (descriptor.some((item) => !/^\d+(?:\.\d+)?[wx]$/i.test(item))) continue;
    let local = null;
    if (safeDataImage(url)) local = url;
    else { const absolute = resolveHttpUrl(url, base); local = absolute && rewrite(absolute, "media"); }
    if (local) out.push([local, ...descriptor].join(" "));
  }
  return out.length ? out.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Node sanitization (server side). Input: raw serialized node from the capture
// script. Output: a clean node in the same shape, or null to drop it.
//   element: { i, t: 1, n, ns?: "svg", a?: [[name, value]], c?: [], sr?: {i, c, css?}, v?, ck?, md?, fr?, css?, cv? }
//   text:    { i, t: 3, x }

export const ATTR_LINK_MARKER = "data-cgm-link";

/**
 * Sanitize one attribute. Returns [name, value] to keep, or null to drop.
 * `ctx.base` is the document base URL; `ctx.rewrite(abs, kind)` maps a remote
 * URL to a same-origin proxy path (or null).
 */
export function sanitizeAttribute(tag, ns, rawName, rawValue, ctx, element = {}) {
  if (typeof rawName !== "string" || typeof rawValue !== "string") return null;
  const name = rawName.toLowerCase();
  if (!/^[a-z_][a-z0-9_.:-]*$/.test(name) || name.length > 64) return null;
  if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "action" || name === "target" ||
      name === "ping" || name === "http-equiv" || name === "nonce" || name === "integrity" || name === "autofocus" ||
      name === "contenteditable" || name === "download" || name === "is" || name === "sandbox" || name === "allow" ||
      name === "method" || name === "enctype" || name === "formtarget" || name === "formmethod" || name === "popovertarget" ||
      name === "usemap" || name === "ismap" || name === "xmlns" || name.startsWith("xmlns:") || name === "poster" ||
      name === "lowsrc" || name === "dynsrc" || name === "longdesc" || name === "cite" || name === "codebase" || name === "manifest") return null;
  const value = rawValue.length > MIRROR_LIMITS.maxAttrValue ? rawValue.slice(0, MIRROR_LIMITS.maxAttrValue) : rawValue;
  const isSvg = ns === "svg";
  const allowed = name.startsWith("aria-") || name.startsWith("data-") && name !== ATTR_LINK_MARKER ||
    (isSvg ? SVG_ATTRS.has(name) : HTML_GLOBAL_ATTRS.has(name) || HTML_ATTRS.has(name));
  if (!allowed) return null;

  if (name === "style") return ["style", rewriteCss(value, ctx.base, ctx.rewrite)];

  // URL-bearing attributes.
  if (name === "href" || name === "xlink:href") {
    if (isSvg) {
      // <use>/<textPath>/gradients may reference local fragments only; <image> may load a proxied picture.
      if (/^\s*#[A-Za-z0-9_:.-]+\s*$/.test(value)) return [name, value.trim()];
      // <use href="sprite.svg#id">: the sprite document loads through the proxy (same origin,
      // served as image/svg+xml under the resource CSP); scripts in it never run.
      const sprite = tag === "use" && /^\s*([^#\s]+)#([A-Za-z0-9_:.-]+)\s*$/.exec(value);
      if (sprite) {
        const absolute = resolveHttpUrl(sprite[1], ctx.base); const local = absolute && ctx.rewrite(absolute, "media");
        return local ? [name, `${local}#${sprite[2]}`] : null;
      }
      if (tag === "image") {
        if (safeDataImage(value)) return [name, value];
        const absolute = resolveHttpUrl(value, ctx.base); const local = absolute && ctx.rewrite(absolute, "media");
        return local ? [name, local] : null;
      }
      return null;
    }
    if (tag === "link") {
      const absolute = resolveHttpUrl(value, ctx.base); const local = absolute && ctx.rewrite(absolute, "css");
      return local ? ["href", local] : null;
    }
    // Links never navigate the user's browser: the href is removed and the
    // element is only marked so it keeps link styling (cursor) via the mirror sheet.
    return null;
  }
  if (name === "src") {
    if (!["img", "source", "input"].includes(tag)) return null;
    if (tag === "input" && String(element.type || "").toLowerCase() !== "image") return null;
    if (safeDataImage(value)) return ["src", value];
    const absolute = resolveHttpUrl(value, ctx.base); const local = absolute && ctx.rewrite(absolute, "media");
    return local ? ["src", local] : null;
  }
  if (name === "srcset") {
    if (!["img", "source"].includes(tag)) return null;
    const rewritten = rewriteSrcset(value, ctx.base, ctx.rewrite);
    return rewritten ? ["srcset", rewritten] : null;
  }
  if (name === "background") {
    const absolute = resolveHttpUrl(value, ctx.base); const local = absolute && ctx.rewrite(absolute, "media");
    return local ? ["background", local] : null;
  }
  if (name === "rel") return tag === "link" ? ["rel", "stylesheet"] : null;
  if (name === "type" && tag === "input") return INPUT_TYPES.has(value.toLowerCase()) ? ["type", value.toLowerCase()] : ["type", "text"];
  if (name === "type" && tag === "button") return ["type", ["submit", "reset", "button"].includes(value.toLowerCase()) ? value.toLowerCase() : "submit"];
  if (name === "value" && tag === "input" && (element.secret === true || String(element.type || "").toLowerCase() === "password")) return null;
  if (name === "popover") return ["popover", "manual"];
  // SVG paint servers / filters may reference local fragments only.
  if (isSvg && /url\s*\(/i.test(value) && !/^\s*url\(\s*["']?#[^)]*\)\s*(?:none|[a-z#0-9(),.%\s-]*)?$/i.test(value)) return null;
  // Belt and braces: no attribute value may carry a script-capable scheme.
  if (dangerousScheme(value) && !(name === "value" || name === "placeholder" || name === "title" || name === "alt" || name === "aria-label" || name.startsWith("data-"))) return null;
  return [isSvg ? svgAttrName(name) : name, value];
}

const attrValue = (attrs, wanted) => {
  if (!Array.isArray(attrs)) return undefined;
  const found = attrs.find((item) => Array.isArray(item) && String(item[0]).toLowerCase() === wanted);
  return found ? String(found[1]) : undefined;
};

/** Decide whether an element is kept and under which tag/namespace. */
export function classifyElement(rawTag, rawNs, attrs) {
  if (typeof rawTag !== "string") return null;
  const tag = rawTag.toLowerCase();
  const ns = rawNs === "svg" ? "svg" : "html";
  if (ns === "svg") return SVG_TAGS.has(tag) && (tag === "title" || !DROP_SUBTREE_TAGS.has(tag)) ? { tag, ns } : null;
  if (DROP_SUBTREE_TAGS.has(tag)) return null;
  if (tag === "link") {
    const rel = (attrValue(attrs, "rel") || "").toLowerCase().split(/\s+/);
    return rel.includes("stylesheet") && !rel.includes("alternate") ? { tag, ns } : null;
  }
  if (tag === "input" && (attrValue(attrs, "type") || "").toLowerCase() === "hidden") return null;
  if (HTML_TAGS.has(tag) || CUSTOM_ELEMENT.test(tag)) return { tag, ns };
  return { tag: "span", ns, unknown: true };
}

/**
 * Sanitize a serialized subtree. Returns { node, count } where node may be null.
 * Enforces depth and node-count limits; throws MirrorLimitError when exceeded.
 */
export class MirrorLimitError extends Error { constructor(reason) { super(reason); this.reason = reason; } }

export function sanitizeTree(raw, ctx, state = { count: 0 }, depth = 0) {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.i) || raw.i <= 0) return null;
  if (depth > MIRROR_LIMITS.maxDepth) return null;
  state.count += 1;
  if (state.count > (ctx.maxNodes ?? MIRROR_LIMITS.maxNodes)) throw new MirrorLimitError("size");
  if (raw.t === 3) {
    const text = typeof raw.x === "string" ? raw.x.slice(0, MIRROR_LIMITS.maxText) : "";
    return { i: raw.i, t: 3, x: text };
  }
  if (raw.t !== 1) return null;
  const kind = classifyElement(raw.n, raw.ns, raw.a);
  if (!kind) return null;
  const { tag, ns } = kind;
  const element = { type: attrValue(raw.a, "type") };
  element.secret = raw.sec === 1 || isSecretField(tag, { type: element.type, autocomplete: attrValue(raw.a, "autocomplete"), name: attrValue(raw.a, "name"), id: attrValue(raw.a, "id") });
  const out = { i: raw.i, t: 1, n: tag };
  if (ns === "svg") out.ns = "svg";
  const attrs = [];
  for (const item of Array.isArray(raw.a) ? raw.a.slice(0, 200) : []) {
    if (!Array.isArray(item)) continue;
    const kept = sanitizeAttribute(tag, ns, item[0], item[1], ctx, element);
    if (kept) attrs.push(kept);
  }
  if (attrs.length) out.a = attrs;
  if (tag === "a" || tag === "area") out.lk = 1;
  if (tag === "style") { out.css = rewriteCss(typeof raw.css === "string" ? raw.css : "", ctx.base, ctx.rewrite); return out; }
  if (tag === "textarea" || tag === "input" || tag === "select") {
    if (typeof raw.v === "string" && !element.secret) out.v = raw.v.slice(0, MIRROR_LIMITS.maxInputValue);
    if (typeof raw.ck === "boolean") out.ck = raw.ck;
    if (tag === "textarea") return out;
  }
  if (tag === "dialog" && raw.md === 1) out.md = 1;
  if (tag === "canvas") { if (typeof raw.cv === "string" && safeCanvasData(raw.cv)) out.cv = raw.cv; return out; }
  if (tag === "iframe") { out.fr = 1; return out; }
  if (Array.isArray(raw.c)) {
    const children = [];
    for (const child of raw.c) { const clean = sanitizeTree(child, ctx, state, depth + 1); if (clean) children.push(clean); }
    if (children.length) out.c = children;
  }
  if (raw.sr && typeof raw.sr === "object" && Number.isInteger(raw.sr.i)) {
    const root = { i: raw.sr.i, c: [] };
    for (const child of Array.isArray(raw.sr.c) ? raw.sr.c : []) { const clean = sanitizeTree(child, ctx, state, depth + 1); if (clean) root.c.push(clean); }
    if (Array.isArray(raw.sr.css)) root.css = raw.sr.css.slice(0, 50).map((sheet) => rewriteCss(String(sheet), ctx.base, ctx.rewrite));
    out.sr = root;
  }
  return out;
}

export const safeCanvasData = (value) => typeof value === "string" && value.length <= MIRROR_LIMITS.maxCanvasDataUrl && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value);

/** Sanitize a mutation batch from the capture script. */
export function sanitizeMutation(raw, ctx) {
  const state = { count: 0 };
  const out = { rems: [], adds: [], attrs: [], texts: [] };
  for (const id of Array.isArray(raw?.rems) ? raw.rems : []) if (Number.isInteger(id) && id > 0) out.rems.push(id);
  for (const add of Array.isArray(raw?.adds) ? raw.adds : []) {
    if (!add || !Number.isInteger(add.p)) continue;
    const node = sanitizeTree(add.node, ctx, state);
    if (node) out.adds.push({ p: add.p, b: Number.isInteger(add.b) ? add.b : null, sr: add.sr === 1 ? 1 : undefined, node });
  }
  for (const change of Array.isArray(raw?.attrs) ? raw.attrs : []) {
    if (!change || !Number.isInteger(change.i) || typeof change.n !== "string") continue;
    const kind = classifyElement(change.tag, change.ns, change.a);
    if (!kind) continue;
    const element = { type: change.type, secret: change.sec === 1 || isSecretField(kind.tag, { type: change.type }) };
    if (change.v === null) {
      const name = String(change.n).toLowerCase();
      if (/^[a-z_][a-z0-9_.:-]*$/.test(name) && !name.startsWith("on")) out.attrs.push({ i: change.i, n: kind.ns === "svg" ? svgAttrName(name) : name, v: null });
      continue;
    }
    const kept = sanitizeAttribute(kind.tag, kind.ns, change.n, String(change.v), ctx, element);
    if (kept) out.attrs.push({ i: change.i, n: kept[0], v: kept[1] });
    else out.attrs.push({ i: change.i, n: kind.ns === "svg" ? svgAttrName(String(change.n).toLowerCase()) : String(change.n).toLowerCase(), v: null });
  }
  for (const text of Array.isArray(raw?.texts) ? raw.texts : []) {
    if (text && Number.isInteger(text.i) && typeof text.x === "string") out.texts.push({ i: text.i, x: text.x.slice(0, MIRROR_LIMITS.maxText) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client-side re-validation: the viewer refuses anything the server should
// already have removed, so a server bug cannot become script execution.

export function clientTagAllowed(tag, ns) {
  if (typeof tag !== "string") return false;
  if (ns === "svg") return SVG_TAGS.has(tag.toLowerCase());
  return HTML_TAGS.has(tag) || CUSTOM_ELEMENT.test(tag) && !DROP_SUBTREE_TAGS.has(tag);
}

export function clientAttrAllowed(tag, ns, name, value) {
  if (typeof name !== "string" || typeof value !== "string") return false;
  const lower = name.toLowerCase();
  if (!/^[a-z_][a-z0-9_.:-]*$/.test(lower) || lower.startsWith("on")) return false;
  if (["srcdoc", "formaction", "action", "target", "http-equiv", "ping", "is", "sandbox", "allow", "contenteditable", "autofocus"].includes(lower)) return false;
  const allowed = lower.startsWith("aria-") || lower.startsWith("data-") ||
    (ns === "svg" ? SVG_ATTRS.has(lower) : HTML_GLOBAL_ATTRS.has(lower) || HTML_ATTRS.has(lower));
  if (!allowed) return false;
  if (lower === "href" || lower === "xlink:href" || lower === "src" || lower === "background") {
    if (ns === "svg" && String(tag).toLowerCase() === "use") { const sprite = /^([^#]+)#[A-Za-z0-9_:.-]+$/.exec(value); if (sprite && isLocalProxyPath(sprite[1])) return true; }
    return isLocalProxyPath(value) || /^#[A-Za-z0-9_:.-]+$/.test(value) && (ns === "svg") || lower === "src" && safeDataImage(value) || ns === "svg" && safeDataImage(value);
  }
  if (lower === "srcset") return value.split(",").every((part) => { const url = part.trim().split(/\s+/)[0]; return isLocalProxyPath(url) || safeDataImage(url); });
  if (lower === "style") return !/javascript:/i.test(value) && clientCssAllowed(value);
  if (dangerousScheme(value) && !["value", "placeholder", "title", "alt", "aria-label"].includes(lower) && !lower.startsWith("data-")) return false;
  return true;
}

export const isLocalProxyPath = (value) => typeof value === "string" && /^\/viewer\/[0-9a-f-]{36}\/m\/r\/[A-Za-z0-9_-]{16,64}$/.test(value);

/** Client check for stylesheet text before it is inserted. */
export function clientCssAllowed(css) {
  if (typeof css !== "string") return false;
  if (/expression\s*\(|-moz-binding|(?:^|[^-\w])behavior\s*:/i.test(css)) return false;
  const urls = css.match(/url\(\s*"[^"]*"\s*\)|url\([^)]*\)/gi) || [];
  return urls.every((item) => /^url\(\s*["']?(?:\/viewer\/[0-9a-f-]{36}\/m\/r\/[A-Za-z0-9_-]+|#[^"')]*|about:invalid|data:(?:image|font|application)\/[^"')]*)["']?\s*\)$/i.test(item));
}

// ---------------------------------------------------------------------------
// Fallback detection (pure). `summary` comes from the capture script.

const CAPTCHA_URL = /(?:^|\/\/)(?:[a-z0-9-]+\.)*(?:google\.com|recaptcha\.net|gstatic\.com)\/recaptcha\/|(?:^|\/\/)(?:[a-z0-9-]+\.)*hcaptcha\.com\/|(?:^|\/\/)challenges\.cloudflare\.com\/|\/turnstile\/v0\//i;

export function detectFallback(summary, limits = MIRROR_LIMITS) {
  if (!summary || typeof summary !== "object") return "error";
  if (summary.error) return "error";
  const urls = [...(Array.isArray(summary.frames) ? summary.frames : []), ...(Array.isArray(summary.scripts) ? summary.scripts : [])];
  if ((Number(summary.markers) || 0) > 0 || urls.some((url) => typeof url === "string" && CAPTCHA_URL.test(url))) return "captcha";
  // A visible cross-origin iframe (e.g. an embedded MFA prompt) is never mirrored,
  // so the page would be unusable: show it in the pixel view instead.
  if ((Number(summary.xframes) || 0) > 0) return "frame";
  const viewport = Math.max(1, (Number(summary.vw) || 0) * (Number(summary.vh) || 0));
  const canvasArea = Number(summary.canvasArea) || 0, canvasCount = Number(summary.canvasCount) || 0;
  if (canvasCount > 4 || canvasArea / viewport > 0.3) return "canvas";
  if ((Number(summary.nodes) || 0) > limits.maxNodes || (Number(summary.bytes) || 0) > limits.maxSnapshotBytes) return "size";
  return null;
}

export const FALLBACK_MESSAGES = Object.freeze({
  captcha: "This page has a security check that needs the classic view.",
  frame: "This page embeds content from another site that needs the classic view.",
  canvas: "This page draws graphics that need the classic view.",
  size: "This page is too large to show as a page view.",
  error: "This page could not be shown as a page view.",
});

// ---------------------------------------------------------------------------
// Input mapping (pure).

/**
 * Plan the minimal remote edit turning `previous` into `next`. Returns null
 * when equal, or { start, end, text } meaning: select [start, end) in the
 * remote field, then insert `text` (empty text = delete the selection).
 * Without selection support the whole value is replaced.
 */
export function planTextEdit(previous, next, selectable = true) {
  const a = String(previous ?? ""), b = String(next ?? "");
  if (a === b) return null;
  if (!selectable) return { start: 0, end: a.length, text: b, all: true };
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start += 1;
  if (start > 0 && start < a.length && /[\uDC00-\uDFFF]/.test(a[start])) start -= 1;
  let suffix = 0;
  while (suffix < max - start && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && /[\uD800-\uDBFF]/.test(a[a.length - suffix - 1] || "") && /[\uDC00-\uDFFF]/.test(a[a.length - suffix] || "")) suffix -= 1;
  return { start, end: a.length - suffix, text: b.slice(start, b.length - suffix) };
}

/** Point inside a CDP content quad for a click at fractional offset (ox, oy) of the element. */
export function clickPoint(quad, ox = 0.5, oy = 0.5) {
  if (!Array.isArray(quad) || quad.length < 8 || quad.some((value) => !Number.isFinite(value))) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  const clamp = (value) => Math.min(0.98, Math.max(0.02, Number.isFinite(value) ? value : 0.5));
  return { x: left + width * clamp(ox), y: top + height * clamp(oy) };
}

/** Validate a client input message. Returns a normalized message or null. */
export function validateInputMessage(value) {
  if (!value || typeof value !== "object") return null;
  const t = value.t;
  const gen = Number.isInteger(value.g) && value.g >= 0 ? value.g : null;
  const frame = Number.isInteger(value.f) && value.f >= 0 && value.f < 10_000 ? value.f : null;
  const id = Number.isInteger(value.i) && value.i > 0 && value.i < 1e9 ? value.i : null;
  const unit = (n) => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
  switch (t) {
    case "click": return gen !== null && frame !== null && id ? { t, g: gen, f: frame, i: id, ox: unit(value.ox), oy: unit(value.oy) } : null;
    case "focus": return gen !== null && frame !== null && id ? { t, g: gen, f: frame, i: id } : null;
    case "input": {
      if (gen === null || frame === null || !id || typeof value.v !== "string" || value.v.length > MIRROR_LIMITS.maxInputValue) return null;
      return { t, g: gen, f: frame, i: id, v: value.v };
    }
    case "select": return gen !== null && frame !== null && id && typeof value.v === "string" && value.v.length <= 1024 ? { t, g: gen, f: frame, i: id, v: value.v } : null;
    case "key": return gen !== null && ["Enter", "Escape", "Tab"].includes(value.k) ? { t, g: gen, f: frame ?? 0, i: id, k: value.k, shift: value.shift === true } : null;
    case "scroll": {
      if (gen === null || frame === null) return null;
      const x = Number(value.x), y = Number(value.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return null;
      return { t, g: gen, f: frame, i: Number.isInteger(value.i) && value.i > 0 ? value.i : 0, x: Math.round(x), y: Math.round(y) };
    }
    case "viewport": {
      const w = Number(value.w), h = Number(value.h);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 200 || h < 200 || w > 3000 || h > 3000) return null;
      // The viewer's color scheme, so the remote page renders the same media-query branch the mirror shows.
      return value.cs === "dark" || value.cs === "light" ? { t, w, h, cs: value.cs } : { t, w, h };
    }
    case "renderer": return value.r === "pixels" || value.r === "mirror" ? { t, r: value.r } : null;
    case "jsdialog": return typeof value.accept === "boolean" ? { t, accept: value.accept } : null;
    default: return null;
  }
}
