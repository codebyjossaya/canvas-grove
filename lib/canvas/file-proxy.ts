import "server-only";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { canvasApiForSession, executeCanvasApiForSession, hostedSessionStore, type HostedSession } from "@/lib/bridge/hosted-browser";
import { healthEventRow } from "./session-health";
import { BridgeError } from "@/lib/bridge/errors";
import type { CanvasRequest } from "@/lib/bridge/types";
import type { AuthContext } from "@/lib/db/auth-context";
import { CANVAS_USER_AGENT, publicOnlyLookup } from "./session-client";

// Canvas content proxy. The user's device never talks to Canvas: Grove asks Canvas for the
// resource with the user's server-held cookie session (API metadata call), then streams the bytes
// back. File bytes come from the signed URL Canvas returns in that metadata, so no Canvas cookie
// is ever sent to a non-Canvas host. GET only; redirects are followed manually, https only, to
// public addresses (publicOnlyLookup) on an allowlist of Canvas file hosts.

export const PROXY_MAX_BYTES = 250 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
/** Hosts Canvas hands file downloads to (signed URLs; no cookies are sent to them). */
const FILE_HOST_SUFFIXES = [".instructure.com", ".amazonaws.com", ".inscloudgate.net", ".canvas-user-content.com", ".instructuremedia.com"];

export class ProxyError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }

export async function activeCanvasSession(ctx: AuthContext): Promise<HostedSession> {
  const sessions = await hostedSessionStore.listForOwner(ctx.clerkUserId);
  const session = sessions.find((item) => item.state === "active");
  if (!session) throw new ProxyError("CANVAS_AUTH_EXPIRED", "Reconnect Canvas to open this.", 401);
  return session;
}

/** One cookie-authenticated Canvas API GET for the signed-in owner. */
export async function ownerCanvasGet(ctx: AuthContext, path: string) {
  const session = await activeCanvasSession(ctx);
  try { return { session, result: await executeCanvasApiForSession(session, ctx.clerkUserId, { method: "GET", path } as CanvasRequest) }; }
  catch (error) {
    if (error instanceof BridgeError && error.code === "CANVAS_SESSION_EXPIRED") throw new ProxyError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas.", 401);
    throw error;
  }
}

export function allowedProxyHost(url: URL, canvasOrigin: string, trustedHosts: string[] = []) {
  if (url.protocol !== "https:") return false;
  if (url.origin === new URL(canvasOrigin).origin) return true;
  if (trustedHosts.includes(url.hostname.toLowerCase())) return true;
  const host = url.hostname.toLowerCase();
  return FILE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function get(url: URL): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: { "user-agent": CANVAS_USER_AGENT, accept: "*/*" }, lookup: publicOnlyLookup, signal: AbortSignal.timeout(TIMEOUT_MS) }, resolve);
    req.on("error", reject); req.end();
  });
}

/**
 * GET a cookie-less URL, following allowlisted redirects; returns the final response stream.
 * `trustStartHost`: the start URL came from Canvas's own API (file metadata), so its host is
 * trusted too. Schools serve signed file URLs from vanity domains (UF: elearning.ufl.edu).
 */
export async function fetchPublic(start: string, canvasOrigin: string, trustStartHost = false): Promise<IncomingMessage> {
  let url = new URL(start);
  const trusted = trustStartHost ? [url.hostname.toLowerCase()] : [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!allowedProxyHost(url, canvasOrigin, trusted)) throw new ProxyError("PROXY_HOST_NOT_ALLOWED", `Canvas sent this file from a host Grove does not proxy (${url.protocol}//${url.hostname}).`, 502);
    let response: IncomingMessage;
    try { response = await get(url); } catch { throw new ProxyError("CANVAS_UNREACHABLE", "Canvas could not be reached from the server.", 503); }
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      // A redirect issued by Canvas itself (its origin or a host it already vouched for) is trusted:
      // that is how Canvas hands off to its vanity domain and file CDN. Third-party hops are not.
      const fromCanvas = url.origin === new URL(canvasOrigin).origin || trusted.includes(url.hostname.toLowerCase());
      url = new URL(response.headers.location, url);
      if (fromCanvas && url.protocol === "https:") trusted.push(url.hostname.toLowerCase());
      continue;
    }
    if (status < 200 || status >= 300) { response.resume(); throw new ProxyError("CANVAS_FILE_UNAVAILABLE", `Canvas answered ${status} for this file.`, status === 404 ? 404 : 502); }
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > PROXY_MAX_BYTES) { response.destroy(); throw new ProxyError("FILE_TOO_LARGE", "This file is too large to open through Grove.", 413); }
    return response;
  }
  throw new ProxyError("TOO_MANY_REDIRECTS", "Canvas redirected this file too many times.", 502);
}

/** Bounded web stream from a node response. */
function webStream(response: IncomingMessage): ReadableStream<Uint8Array> {
  let total = 0;
  const source = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > PROXY_MAX_BYTES) { response.destroy(); controller.error(new Error("too large")); return; }
      controller.enqueue(chunk);
    },
  }));
}

const INLINE_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|text\/plain|audio\/|video\/)/i;
function disposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
/** Headers that keep proxied bytes inert on Grove's origin. PDFs need the browser viewer, which a sandbox CSP blocks. */
export function proxyHeaders(contentType: string, name: string, inline: boolean, length?: number) {
  const type = contentType || "application/octet-stream";
  const showInline = inline && INLINE_TYPES.test(type);
  const headers = new Headers({
    "content-type": showInline || !/html|xml|javascript/i.test(type) ? type : "application/octet-stream",
    "content-disposition": disposition(showInline ? "inline" : "attachment", name || "file"),
    "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  });
  if (!/^application\/pdf/i.test(type)) headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  if (length && Number.isFinite(length)) headers.set("content-length", String(length));
  return headers;
}

/**
 * The download URL in file metadata needs the user's Canvas session (without it Canvas redirects to
 * /login). Make that single hop with the user's cookies; Canvas answers with the signed file
 * location, which is then fetched cookie-less.
 */
async function signedFileLocation(ctx: AuthContext, session: HostedSession, metaUrl: string): Promise<string> {
  const origin = new URL(session.canvasOrigin).origin;
  const url = new URL(metaUrl);
  if (url.origin !== origin) return metaUrl; // already off-Canvas (e.g. a CDN URL): no cookies needed
  const client = canvasApiForSession(session, ctx.clerkUserId);
  try {
    const result = await client.fileRedirect(`${url.pathname}${url.search}`);
    if (result.authRequired) {
      await hostedSessionStore.updateForOwner(session.id, ctx.clerkUserId, { state: "auth-expired", lastError: "CANVAS_SESSION_EXPIRED" });
      throw new ProxyError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas.", 401);
    }
    if (!result.location) throw new ProxyError("CANVAS_FILE_UNAVAILABLE", `Canvas answered ${result.status} for this file.`, result.status === 404 ? 404 : 502);
    return result.location;
  } catch (error) {
    if (error instanceof BridgeError && error.code === "CANVAS_PATH_NOT_ALLOWED") throw new ProxyError("CANVAS_FILE_UNAVAILABLE", "Canvas returned an unexpected download link for this file.", 502);
    throw error;
  } finally {
    await client.flush().catch(() => undefined);
    const row = healthEventRow(client.stats(), { ownerId: session.userId, hostedSessionId: session.id, kind: "api" });
    if (row) await hostedSessionStore.recordHealthEvent(session.id, ctx.clerkUserId, row).catch(() => undefined);
  }
}

/** Stream one Canvas file by its Canvas id. Canvas itself enforces access with the user's session. */
export async function proxyCanvasFile(ctx: AuthContext, canvasFileId: string, inline: boolean): Promise<Response> {
  if (!/^\d{1,20}$/.test(canvasFileId)) throw new ProxyError("INVALID_FILE", "Invalid Canvas file id.", 400);
  const { session, result } = await ownerCanvasGet(ctx, `/api/v1/files/${canvasFileId}`);
  if (result.authRequired) throw new ProxyError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas.", 401);
  if (!result.ok) throw new ProxyError("CANVAS_FILE_UNAVAILABLE", result.status === 404 ? "This file no longer exists in Canvas." : "Canvas did not allow access to this file.", result.status === 404 ? 404 : 403);
  const meta = (result.data && typeof result.data === "object" ? result.data : {}) as Record<string, unknown>;
  if (meta.locked_for_user === true || typeof meta.url !== "string" || !meta.url) {
    throw new ProxyError("CANVAS_FILE_LOCKED", typeof meta.lock_explanation === "string" ? meta.lock_explanation.replace(/<[^>]*>/g, "") : "This file is locked in Canvas.", 403);
  }
  const response = await fetchPublic(await signedFileLocation(ctx, session, meta.url), session.canvasOrigin, true);
  const type = String(meta["content-type"] ?? response.headers["content-type"] ?? "application/octet-stream");
  const declared = Number(response.headers["content-length"]);
  return new Response(webStream(response), { status: 200, headers: proxyHeaders(type, String(meta.display_name ?? meta.filename ?? "file"), inline, Number.isFinite(declared) ? declared : undefined) });
}

/** Canvas renders LaTeX to SVG at /equation_images/<latex>. Public on Canvas; fetched cookie-less. */
export async function proxyEquationImage(ctx: AuthContext, pathAndQuery: string): Promise<Response> {
  if (!/^\/equation_images\/\S{1,4000}$/.test(pathAndQuery) || pathAndQuery.includes("..")) throw new ProxyError("INVALID_EQUATION", "Invalid equation image path.", 400);
  const session = await activeCanvasSession(ctx);
  const target = new URL(pathAndQuery, session.canvasOrigin);
  if (target.origin !== new URL(session.canvasOrigin).origin || !target.pathname.startsWith("/equation_images/")) throw new ProxyError("INVALID_EQUATION", "Invalid equation image path.", 400);
  const response = await fetchPublic(target.toString(), session.canvasOrigin);
  const type = String(response.headers["content-type"] ?? "image/svg+xml");
  if (!/^image\//i.test(type)) { response.destroy(); throw new ProxyError("INVALID_EQUATION", "Canvas did not return an image.", 502); }
  const headers = proxyHeaders(type, "equation.svg", true);
  headers.set("cache-control", "private, max-age=86400");
  return new Response(webStream(response), { status: 200, headers });
}

export function proxyErrorResponse(error: unknown): Response {
  if (error instanceof Error && error.message.includes("During prerendering")) throw error;
  if (error instanceof ProxyError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  console.error("canvas_proxy_failed", { error: error instanceof Error ? error.message : "unknown" });
  return Response.json({ error: "Grove could not fetch this from Canvas.", code: "PROXY_FAILED" }, { status: 502 });
}
