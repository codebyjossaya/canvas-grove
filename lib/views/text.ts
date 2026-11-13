// Pure text helpers shared by server loaders and client components. Canvas HTML is never
// rendered as HTML anywhere in the app; it is reduced to plain paragraphs here.
const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

export function decodeEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi, (match, name: string) => {
    const key = name.toLowerCase();
    if (key in entities) return entities[key];
    if (key.startsWith("#x")) { const code = Number.parseInt(key.slice(2), 16); return Number.isFinite(code) ? String.fromCodePoint(code) : match; }
    if (key.startsWith("#")) { const code = Number.parseInt(key.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : match; }
    return match;
  });
}

export function plainText(html: string | null | undefined, max = Infinity) {
  if (!html) return "";
  const text = decodeEntities(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function htmlToParagraphs(html: string | null | undefined, maxParagraphs = 80) {
  if (!html) return [];
  const blocks = decodeEntities(html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n\n• ")
    .replace(/<\/?(p|div|h[1-6]|ul|ol|li|table|tr|blockquote|section|article)[^>]*>/gi, "\n\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .split(/\n{2,}/)
    .map(part => part.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim())
    .filter(Boolean);
  return blocks.slice(0, maxParagraphs);
}

export function initials(value: string) {
  const parts = value.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0].slice(0, 2)).toUpperCase();
}

export function safeHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : null; } catch { return null; }
}

export function safeInternalPath(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : null;
}
