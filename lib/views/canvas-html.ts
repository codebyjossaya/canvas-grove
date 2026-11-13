import { safeQuizHtml } from "@/lib/quizzes/contracts";

// Canvas-authored HTML → HTML that is safe to render inside Grove and keeps the user inside Grove.
// Pure (no server-only imports): used by server loaders, client components and unit tests.
//
// Links and images that point at the user's Canvas are rewritten:
//   files (/courses/:c/files/:id, /files/:id/download, …) → /api/canvas/files/:id (server-side proxy)
//   equation images (/equation_images/…)                  → /api/canvas/equation?p=… (server-side proxy)
//   assignments / quizzes / pages / course sections       → Grove routes, via the optional resolver
// Anything on Canvas Grove cannot wrap stays a Canvas link, marked data-link="canvas".

/** Maps a same-origin Canvas URL to a Grove route, or null when Grove has no view for it. */
export type CanvasLinkResolver = (url: URL) => string | null;

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeAttr = (value: string) => value.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function resolveUrl(value: string, origin: string | null, protocols: string[]) {
  const raw = unescapeAttr(value).trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!raw) return null;
  if (raw.startsWith("#")) return raw;
  try {
    const url = origin ? new URL(raw, origin) : new URL(raw);
    return protocols.includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
function parseAttrs(source: string) {
  const attrs: Array<[string, string | null]> = [];
  for (const match of source.matchAll(attrPattern)) {
    const raw = match[2];
    attrs.push([match[1].toLowerCase(), raw == null ? null : raw.replace(/^(["'])([\s\S]*)\1$/, "$2")]);
  }
  return attrs;
}
const attr = (attrs: Array<[string, string | null]>, name: string) => attrs.find(([key]) => key === name)?.[1] ?? null;

/** Attributes that would override the app theme (colors, fonts, sizing) or collide with app class names. */
const PRESENTATIONAL_ATTRS = /\s(class|color|bgcolor|background|face|size|border|cellpadding|cellspacing|width|height|align|valign)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

const FILE_PATH =/^\/(?:(?:courses|users|groups)\/\d{1,20}\/)?files\/(\d{1,20})(?:\/(download|preview|file_preview|inline_view))?\/?$/;

/** Grove proxy route for a Canvas file or equation image URL on the user's Canvas, else null. Pure. */
export function canvasProxyHref(url: URL, canvasOrigin: string | null): string | null {
  if (!canvasOrigin || url.origin !== canvasOrigin) return null;
  const file = FILE_PATH.exec(url.pathname);
  if (file) return `/api/canvas/files/${file[1]}?inline=1`;
  if (url.pathname.startsWith("/equation_images/")) return `/api/canvas/equation?p=${encodeURIComponent(url.pathname + url.search)}`;
  return null;
}

type Classified = { href: string; kind: "anchor" | "internal" | "file" | "canvas" | "external" | "mail" };
function classifyLink(resolved: string, origin: string | null, resolve?: CanvasLinkResolver): Classified {
  if (resolved.startsWith("#")) return { href: resolved, kind: "anchor" };
  const url = new URL(resolved);
  if (url.protocol === "mailto:") return { href: resolved, kind: "mail" };
  if (origin && url.origin === origin) {
    const proxied = canvasProxyHref(url, origin);
    if (proxied) return { href: proxied, kind: "file" };
    const internal = resolve?.(url);
    if (internal && internal.startsWith("/") && !internal.startsWith("//")) return { href: internal, kind: "internal" };
    return { href: resolved, kind: "canvas" };
  }
  return { href: resolved, kind: "external" };
}

function linkTag(target: Classified, keep: string) {
  const blank = target.kind === "external" || target.kind === "canvas" || target.kind === "file";
  return `<a href="${escapeAttr(target.href)}" data-link="${target.kind}"${keep}${blank ? " target=\"_blank\" rel=\"noopener noreferrer\"" : ""}>`;
}

/** Sanitize Canvas-authored HTML for display: strips scripts/handlers/styles, rewrites Canvas links
 *  and images to Grove (proxy or native route), turns embeds into links and tidies empty markup. */
export function renderCanvasHtml(html: string | null | undefined, origin: string | null, resolve?: CanvasLinkResolver): string {
  if (!html || !html.trim()) return "";
  let canvasOrigin: string | null = null;
  try { canvasOrigin = origin ? new URL(origin).origin : null; } catch { canvasOrigin = null; }
  // Embedded players/documents cannot run here; keep them reachable as a link before the sanitizer drops them.
  let out = html.slice(0, 200_000).replace(/<iframe\b([^>]*)>[\s\S]*?<\/iframe>|<iframe\b([^>]*)\/?>/gi, (_m, a?: string, b?: string) => {
    const attrs = parseAttrs(a ?? b ?? "");
    const src = attr(attrs, "src");
    const title = attr(attrs, "title") || attr(attrs, "aria-label") || "Embedded content";
    return src ? `<p><a href="${escapeAttr(src)}" data-embed="1">${escapeText(unescapeAttr(title))}</a></p>` : "";
  });
  out = safeQuizHtml(out)
    .replace(/<(link|meta|base)\b[^>]*>/gi, "")
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(srcset|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Theme consistency: nothing Canvas-authored may set colors, fonts, sizes or app class names.
    .replace(/<\/?(font|center|basefont)\b[^>]*>/gi, "")
    .replace(/<([a-z][a-z0-9]*)\b([^>]*)>/gi, (_m, tag: string, attrs: string) => `<${tag}${attrs.replace(PRESENTATIONAL_ATTRS, "")}>`)
    // Canvas editor leftovers: empty paragraphs/spans and long <br> runs.
    .replace(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, "")
    .replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>")
    .replace(/<span\b[^>]*>\s*<\/span>/gi, "");
  out = out.replace(/<a\b([^>]*)>/gi, (_m, rest: string) => {
    const attrs = parseAttrs(rest);
    const href = attr(attrs, "href");
    const resolved = href == null ? null : resolveUrl(href, canvasOrigin, ["http:", "https:", "mailto:"]);
    const keep = attrs.filter(([name]) => name === "title" || name === "id" || name === "name").map(([n, v]) => v == null ? ` ${n}` : ` ${n}="${escapeAttr(v)}"`).join("");
    if (!resolved) return `<a${keep}>`;
    const target = classifyLink(resolved, canvasOrigin, resolve);
    return linkTag(target, keep + (attr(attrs, "data-embed") ? " data-embed=\"1\"" : ""));
  });
  out = out.replace(/<img\b([^>]*)>/gi, (_m, rest: string) => {
    const attrs = parseAttrs(rest);
    const src = attr(attrs, "src");
    const resolved = src == null ? null : resolveUrl(src, canvasOrigin, ["http:", "https:"]);
    if (!resolved) return "";
    const url = new URL(resolved);
    const proxied = canvasProxyHref(url, canvasOrigin);
    const equation = attr(attrs, "data-equation-content");
    const alt = attr(attrs, "alt") ?? equation ?? "";
    const finalSrc = proxied ?? resolved;
    const cls = equation || url.pathname.startsWith("/equation_images/") ? " data-equation=\"1\"" : "";
    return `<img src="${escapeAttr(finalSrc)}" alt="${escapeAttr(unescapeAttr(alt))}"${equation ? ` title="${escapeAttr(unescapeAttr(equation))}"` : ""}${cls} loading="lazy" referrerpolicy="no-referrer">`;
  });
  // Last guard: neutralize any dangerous opening tag that survived nested or split input.
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|base)\b/gi, "&lt;$1");
  return out.trim();
}

/** Canvas ids referenced by links in some HTML, so a server loader can build a resolver in one query per kind. */
export function canvasReferences(htmls: Array<string | null | undefined>, canvasOrigin: string | null) {
  const courses = new Set<string>(), assignments = new Set<string>(), quizzes = new Set<string>(), pages = new Set<string>();
  if (!canvasOrigin) return { courses, assignments, quizzes, pages };
  for (const html of htmls) {
    if (!html) continue;
    for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      let url: URL; try { url = new URL(unescapeAttr(match[1]), canvasOrigin); } catch { continue; }
      if (url.origin !== canvasOrigin) continue;
      const parts = /^\/courses\/(\d{1,20})(?:\/(assignments|quizzes|pages)\/([^/?#]+))?/.exec(url.pathname);
      if (!parts) continue;
      courses.add(parts[1]);
      if (parts[2] === "assignments" && /^\d+$/.test(parts[3])) assignments.add(parts[3]);
      if (parts[2] === "quizzes" && /^\d+$/.test(parts[3])) quizzes.add(parts[3]);
      if (parts[2] === "pages") pages.add(`${parts[1]}/${decodeURIComponent(parts[3])}`);
    }
  }
  return { courses, assignments, quizzes, pages };
}
