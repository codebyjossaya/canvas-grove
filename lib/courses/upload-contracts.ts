import { Buffer } from "node:buffer";

export const COURSE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const MCP_UPLOAD_MAX_BYTES = 512 * 1024;
export const MCP_UPLOAD_MAX_BASE64_CHARS = Math.ceil(MCP_UPLOAD_MAX_BYTES / 3) * 4;
export const COURSE_UPLOAD_ACCEPT = ".pdf,.txt,.md,.csv,.rtf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

export class CourseUploadError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export type CourseUploadMeta = { filename: string; contentType: string; size: number; folderId: string | null };

export function parseCourseUploadMeta(value: { filename?: unknown; contentType?: unknown; size?: unknown; folderId?: unknown }, maxBytes = COURSE_UPLOAD_MAX_BYTES): CourseUploadMeta {
  const rawName = typeof value.filename === "string" ? value.filename.normalize("NFC") : "";
  if (!rawName || rawName !== rawName.trim() || rawName === "." || rawName === ".." || /[\\/\u0000-\u001f\u007f]/.test(rawName)
    || rawName.length > 200 || Buffer.byteLength(rawName, "utf8") > 240) {
    throw new CourseUploadError("INVALID_FILENAME", "Choose a filename between 1 and 200 characters without paths or control characters.");
  }
  const extension = rawName.includes(".") ? rawName.split(".").at(-1)!.toLowerCase() : "";
  const expected = MIME_BY_EXTENSION[extension];
  if (!expected) throw new CourseUploadError("FILE_TYPE_NOT_ALLOWED", `Allowed document types: ${Object.keys(MIME_BY_EXTENSION).join(", ")}.`, 415);
  const supplied = typeof value.contentType === "string" ? value.contentType.split(";", 1)[0].trim().toLowerCase() : "";
  const contentType = !supplied || supplied === "application/octet-stream" ? expected : supplied;
  if (contentType !== expected) throw new CourseUploadError("FILE_TYPE_MISMATCH", `The filename and content type do not match (${extension} requires ${expected}).`, 415);
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new CourseUploadError("INVALID_FILE_SIZE", "The document must contain at least one byte.");
  if (size > maxBytes) throw new CourseUploadError("FILE_TOO_LARGE", `The document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB upload limit.`, 413);
  const folderId = value.folderId == null || value.folderId === "" ? null : String(value.folderId);
  if (folderId && !/^\d{1,20}$/.test(folderId)) throw new CourseUploadError("INVALID_FOLDER", "Choose a valid Canvas course folder.");
  return { filename: rawName, contentType, size, folderId };
}

export function decodeBase64Document(value: string, maxBytes = MCP_UPLOAD_MAX_BYTES): Buffer {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new CourseUploadError("INVALID_BASE64", "contentBase64 must be standard base64 within the documented limit.");
  }
  const bytes = Buffer.from(value, "base64");
  const canonical = value.replace(/=+$/, "");
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString("base64").replace(/=+$/, "") !== canonical) {
    throw new CourseUploadError(bytes.length > maxBytes ? "FILE_TOO_LARGE" : "INVALID_BASE64", bytes.length > maxBytes ? "The MCP document exceeds 512 KiB." : "contentBase64 is not valid canonical base64.", bytes.length > maxBytes ? 413 : 400);
  }
  return bytes;
}

function allowedStorageHost(hostname: string, canvasHost: string): boolean {
  const host = hostname.toLowerCase();
  if (host === canvasHost.toLowerCase()) return true;
  if (/(^|\.)(instructure\.com|canvas-user-content\.com|inscloudgate\.net)$/.test(host)) return true;
  return host === "s3.amazonaws.com" || /(^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
}

export function validateCanvasUploadUrl(value: string, canvasOrigin: string): URL {
  let target: URL;
  let canvas: URL;
  try { target = new URL(value); canvas = new URL(canvasOrigin); }
  catch { throw new CourseUploadError("UNSAFE_UPLOAD_URL", "Canvas returned an invalid upload destination.", 502); }
  if (target.protocol !== "https:" || target.username || target.password || target.hash || (target.port && target.port !== "443")
    || !allowedStorageHost(target.hostname, canvas.hostname)) {
    throw new CourseUploadError("UNSAFE_UPLOAD_URL", "Canvas returned an upload destination outside Grove's trusted file hosts.", 502);
  }
  return target;
}

/** Redirects are followed only as body-free GETs, and only to the same storage origin or Canvas itself. */
export function nextCanvasUploadRedirect(status: number, location: string | undefined, current: URL, canvasOrigin: string): URL | null {
  if (status < 300 || status >= 400) return null;
  if (!location) throw new CourseUploadError("UNSAFE_UPLOAD_REDIRECT", "The Canvas upload redirect had no destination.", 502);
  if (status === 307 || status === 308) throw new CourseUploadError("UNSAFE_UPLOAD_REDIRECT", "Grove refused a redirect that could retransmit the document bytes.", 502);
  if (![301, 302, 303].includes(status)) throw new CourseUploadError("UNSAFE_UPLOAD_REDIRECT", "Canvas returned an unsupported upload redirect.", 502);
  const target = validateCanvasUploadUrl(new URL(location, current).toString(), canvasOrigin);
  const canvas = new URL(canvasOrigin);
  if (target.origin !== current.origin && target.origin !== canvas.origin) {
    throw new CourseUploadError("UNSAFE_UPLOAD_REDIRECT", "Grove refused a cross-host upload redirect.", 502);
  }
  return target;
}

function quoteDisposition(value: string) { return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }

/** Builds only the small multipart envelope; the file bytes remain a stream between prefix and suffix. */
export function multipartEnvelope(fields: Record<string, string>, meta: CourseUploadMeta, boundary: string) {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(boundary)) throw new CourseUploadError("INVALID_MULTIPART", "Invalid multipart boundary.", 500);
  const entries = Object.entries(fields);
  if (entries.length > 50 || entries.some(([key, value]) => !key || /[\r\n\u0000"]/u.test(key) || /[\r\n\u0000]/u.test(value))
    || entries.reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > 64 * 1024) {
    throw new CourseUploadError("INVALID_UPLOAD_PARAMETERS", "Canvas returned unsafe or oversized upload parameters.", 502);
  }
  const fieldParts = entries.map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${quoteDisposition(key)}"\r\n\r\n${value}\r\n`).join("");
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoteDisposition(meta.filename)}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}\r\nContent-Type: ${meta.contentType}\r\n\r\n`;
  const prefix = Buffer.from(fieldParts + fileHeader, "utf8");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { prefix, suffix, contentLength: prefix.length + meta.size + suffix.length };
}
