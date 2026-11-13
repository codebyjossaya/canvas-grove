// Server-side, cookie-authenticated Canvas REST client.
//
// The hosted browser is used ONLY for interactive sign-in. Once Canvas accepts
// the user, the cookie jar is captured (envelope-encrypted) and the browser is
// destroyed. Every later Canvas call, from the sync worker and from the app,
// goes through this client: it decrypts the stored jar, sends only cookies that
// RFC 6265 would send to the Canvas origin, calls only `${canvasOrigin}/api/v1/`,
// never follows redirects, pins DNS to public addresses, bounds every response
// and persists Set-Cookie rotations with optimistic concurrency.
//
// Relative imports and no "server-only": the sync worker loads this via tsx.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
import { BridgeError } from "../bridge/errors";
import type { EncryptedBrowserState } from "../bridge/hosted-browser";
import { envelopeDecryptBrowserState, envelopeEncryptBrowserState } from "../bridge/providers/envelope";
import type { CanvasRequest } from "../bridge/types";
import { isPublicAddress } from "./network-policy";

/** Playwright storageState cookie shape (what snapshotEncrypted stores). `expires` is epoch seconds, -1 for a session cookie. */
export type StoredCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" };
export type StoredBrowserState = { cookies: StoredCookie[]; origins?: unknown[] };
export type CookieUpdate = { cookie: StoredCookie; remove: boolean };

export const CANVAS_PAGE_SIZE = 100;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_CLIENT_BYTES = 96 * 1024 * 1024;
export const MAX_IN_FLIGHT = 4;
/** touchSession reads at most this much of the HTML page, then discards it. */
export const TOUCH_BODY_CAP_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 20_000;
export const CANVAS_USER_AGENT = "CanvasGrove/1.0 (server-side Canvas sync; cookie session captured by user sign-in)";
/** Cookies whose rotation is the signal the 24h session-lifetime test measures. */
export const SESSION_COOKIE_NAMES = ["_normandy_session", "_legacy_normandy_session", "canvas_session"];
/** Canvas keeps session data (and its sliding `expire_after`) inside this encrypted cookie. */
export const PRIMARY_SESSION_COOKIE = "_normandy_session";
/** Authlogic remember-me (remember_me_for 2 weeks); can silently re-authenticate after expiry. */
export const REMEMBER_COOKIE = "pseudonym_credentials";

export class CanvasResponseTooLargeError extends BridgeError {
  constructor() { super("CANVAS_RESPONSE_TOO_LARGE", "Canvas returned a response larger than the sync limit.", 502); }
}

// ---------------------------------------------------------------- validation

/** Same rules the in-browser executor enforced, plus dot-segment and control-character rejection. */
export function validateCanvasApiPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/api/v1/") || path.includes("//") || path.includes("\\") || path.includes("#")
    || /(^|\/)\.\.?(\/|\?|$)/.test(path.split("?")[0]) || /%2e%2e|%2f|%5c/i.test(path.split("?")[0]) || /[\u0000- \u007f]/.test(path)) {
    throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas request path is not allowed", 400);
  }
  return path;
}

export function canvasApiUrl(canvasOrigin: string, path: string): URL {
  const origin = new URL(canvasOrigin);
  if (origin.protocol !== "https:" || origin.origin !== canvasOrigin.replace(/\/$/, "")) throw new BridgeError("CANVAS_ORIGIN_INVALID", "The Canvas origin must be an exact https origin.", 400);
  const url = new URL(validateCanvasApiPath(path), origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith("/api/v1/")) throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas request path is not allowed", 400);
  return url;
}

// ---------------------------------------------------------------- quiz web paths
//
// Canvas only serves one-question-at-a-time Classic quizzes through its own
// quiz player (the REST questions API answers 401 for them). These are the
// exact, non-API player routes native Quiz Mode may use. Nothing else outside
// /api/v1/ is ever requested; the next_question_path must stay inside the same
// course and quiz.
export type QuizWebMethod = "GET" | "POST" | "PUT";
const QUIZ_WEB_ROUTES: ReadonlyArray<{ method: QuizWebMethod; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/courses\/\d{1,20}\/quizzes\/\d{1,20}\/take$/ },
  { method: "GET", pattern: /^\/courses\/\d{1,20}\/quizzes\/\d{1,20}\/take\/questions\/\d{1,20}$/ },
  { method: "POST", pattern: /^\/courses\/\d{1,20}\/quizzes\/\d{1,20}\/take\?user_id=\d{1,20}$/ },
  { method: "POST", pattern: /^\/courses\/(\d{1,20})\/quizzes\/(\d{1,20})\/submissions\/\d{1,20}\/record_answer\?next_question_path=%2Fcourses%2F\1%2Fquizzes%2F\2%2Ftake(?:%2Fquestions%2F\d{1,20})?&user_id=\d{1,20}$/ },
  { method: "PUT", pattern: /^\/courses\/\d{1,20}\/quizzes\/\d{1,20}\/submissions\/backup\?user_id=\d{1,20}$/ },
  { method: "POST", pattern: /^\/courses\/\d{1,20}\/quizzes\/\d{1,20}\/submissions\?user_id=\d{1,20}$/ },
];
/** Largest quiz player page Quiz Mode will read (recorded pages are ~85 KB). */
export const QUIZ_WEB_MAX_BYTES = 2 * 1024 * 1024;

export function validateQuizWebPath(method: string, path: string): string {
  if (typeof path !== "string" || !QUIZ_WEB_ROUTES.some((route) => route.method === method && route.pattern.test(path))) {
    throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas quiz request path is not allowed", 400);
  }
  return path;
}

export function canvasQuizWebUrl(canvasOrigin: string, method: string, path: string): URL {
  const origin = new URL(canvasOrigin);
  if (origin.protocol !== "https:" || origin.origin !== canvasOrigin.replace(/\/$/, "")) throw new BridgeError("CANVAS_ORIGIN_INVALID", "The Canvas origin must be an exact https origin.", 400);
  const url = new URL(validateQuizWebPath(method, path), origin);
  if (url.origin !== origin.origin || `${url.pathname}${url.search}` !== path) throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas quiz request path is not allowed", 400);
  return url;
}

export type QuizWebRequest = {
  method: QuizWebMethod; path: string;
  /** Form fields, sent application/x-www-form-urlencoded in this order. */
  form?: Array<[string, string]>;
  /** Add Canvas's CSRF `authenticity_token` (from the `_csrf_token` cookie) to the form. The caller never sees it. */
  authenticityToken?: boolean;
  /** "json" mimics the player's XHR (backup); "html" a document navigation. */
  accept?: "html" | "json";
};
export type QuizWebResult = {
  status: number; authRequired: boolean; contentType: string;
  /** Same-origin redirect target (path + query), or null. Redirects are never followed. */
  location: string | null;
  /** UTF-8 body, empty when authRequired. */
  body: string;
};

/** Interpret a quiz player response: a redirect to login/SSO or off-origin is an expired session; a 401 is expiry unless Canvas says "unauthorized". */
export function interpretQuizWebResponse(response: TransportResponse, canvasOrigin: string): QuizWebResult {
  const origin = new URL(canvasOrigin).origin;
  const raw = headerValue(response.headers, "location");
  let location: string | null = null;
  if (response.status >= 300 && response.status < 400 && raw) {
    try { const target = new URL(raw, origin); if (target.origin === origin) location = `${target.pathname}${target.search}`; } catch { location = null; }
  }
  const authRequired = response.status === 401 ? !isPermissionDenial401(response.body)
    : response.status >= 300 && response.status < 400 ? (!raw || isAuthFailure(response.status, response.headers, canvasOrigin)) : false;
  return { status: response.status, authRequired, contentType: headerValue(response.headers, "content-type") ?? "", location: authRequired ? null : location, body: authRequired ? "" : response.body.toString("utf8") };
}

// ---------------------------------------------------------------- file download hand-off
//
// Canvas serves a course file only to a signed-in user: GET /files/:id/download answers with a
// redirect to the real (signed, cookie-less) file location. Grove's file proxy makes exactly that
// one request with the user's cookies and never follows the redirect with them.
const FILE_DOWNLOAD_PATH = /^\/(?:courses\/\d{1,20}\/)?files\/\d{1,20}\/download\?download_frd=1(?:&verifier=[A-Za-z0-9_-]{1,128})?$/;
export const FILE_REDIRECT_BODY_CAP = 64 * 1024;
/** Hosts Canvas hands signed file downloads to. */
const FILE_HANDOFF_HOST = /(^|\.)(canvas-user-content\.com|instructure\.com|inscloudgate\.net|amazonaws\.com|instructuremedia\.com)$/i;
export type FileRedirectResult = { status: number; authRequired: boolean; location: string | null };

export function validateFileDownloadPath(path: string): string {
  if (typeof path !== "string" || !FILE_DOWNLOAD_PATH.test(path)) throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas file request path is not allowed", 400);
  return path;
}

// ---------------------------------------------------------------- cookie jar

function domainMatches(host: string, cookieDomain: string): boolean {
  const domain = cookieDomain.toLowerCase();
  if (domain.startsWith(".")) { const bare = domain.slice(1); return host === bare || host.endsWith(domain); }
  return host === domain; // host-only cookie
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  const path = cookiePath || "/";
  if (requestPath === path) return true;
  return requestPath.startsWith(path) && (path.endsWith("/") || requestPath.charAt(path.length) === "/");
}

/** RFC 6265 §5.4 selection for one request URL. IdP and other-host cookies are never selected. */
export function cookiesForRequest(cookies: StoredCookie[], url: URL, nowMs = Date.now()): StoredCookie[] {
  const host = url.hostname.toLowerCase();
  return cookies.filter((cookie) => typeof cookie?.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string"
    && domainMatches(host, cookie.domain)
    && pathMatches(url.pathname, typeof cookie.path === "string" ? cookie.path : "/")
    && (!cookie.secure || url.protocol === "https:")
    && !(typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires * 1000 <= nowMs))
    // Longer paths first (RFC 6265 §5.4 step 2).
    .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0));
}

export function cookieHeader(cookies: StoredCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function defaultPath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith("/") || path.lastIndexOf("/") === 0) return "/";
  return path.slice(0, path.lastIndexOf("/"));
}

/** Parse one Set-Cookie header against the URL that returned it. Returns null for cookies a browser would reject. */
export function parseSetCookie(header: string, requestUrl: URL, nowMs = Date.now()): CookieUpdate | null {
  const [pair, ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim(); const value = pair.slice(separator + 1).trim();
  if (!name || /[\s;,=]/.test(name)) return null;
  const host = requestUrl.hostname.toLowerCase();
  let domain = host; let path = defaultPath(requestUrl); let expires = -1; let maxAge: number | null = null;
  let secure = false; let httpOnly = false; let sameSite: StoredCookie["sameSite"] = "Lax";
  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const raw = index < 0 ? "" : attribute.slice(index + 1).trim();
    if (key === "domain" && raw) {
      const candidate = raw.replace(/^\./, "").toLowerCase();
      // A response may only set cookies for its own host or a parent of it.
      if (!(host === candidate || host.endsWith(`.${candidate}`)) || !candidate.includes(".")) return null;
      domain = `.${candidate}`;
    } else if (key === "path" && raw.startsWith("/")) path = raw;
    else if (key === "expires") { const parsed = Date.parse(raw); if (Number.isFinite(parsed)) expires = Math.floor(parsed / 1000); }
    else if (key === "max-age" && /^-?\d+$/.test(raw)) maxAge = Number(raw);
    else if (key === "secure") secure = true;
    else if (key === "httponly") httpOnly = true;
    else if (key === "samesite") sameSite = /^strict$/i.test(raw) ? "Strict" : /^none$/i.test(raw) ? "None" : "Lax";
  }
  if (maxAge !== null) expires = maxAge <= 0 ? 0 : Math.floor(nowMs / 1000) + maxAge;
  const remove = expires === 0 || (expires > 0 && expires * 1000 <= nowMs);
  return { remove, cookie: { name, value, domain, path, expires: remove ? 0 : expires, httpOnly, secure, sameSite } };
}

const cookieKey = (cookie: StoredCookie) => `${cookie.name}\u0000${cookie.domain.toLowerCase()}\u0000${cookie.path || "/"}`;

/** Apply rotations by (name, domain, path). Session cookies without an expiry are kept. */
export function mergeCookies(jar: StoredCookie[], updates: CookieUpdate[]): StoredCookie[] {
  const merged = new Map(jar.map((cookie) => [cookieKey(cookie), cookie]));
  for (const update of updates) {
    const key = cookieKey(update.cookie);
    if (update.remove) merged.delete(key);
    else merged.set(key, update.cookie);
  }
  return [...merged.values()];
}

function csrfToken(cookies: StoredCookie[]): string | undefined {
  const raw = cookies.find((cookie) => cookie.name === "_csrf_token")?.value;
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// ---------------------------------------------------------------- transport

export type TransportRequest = { url: URL; method: CanvasRequest["method"]; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number;
  /** Keep the first maxBytes and discard the rest instead of failing (page touches). */ truncate?: boolean };
export type TransportResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };
export type CanvasTransport = (request: TransportRequest) => Promise<TransportResponse>;

/** Read a body, aborting as soon as it exceeds maxBytes; nothing past the limit is buffered. */
export async function readBounded(stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > maxBytes) throw new CanvasResponseTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/** Read at most maxBytes, then stop; the remainder is never buffered. */
export async function readCapped(stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const take = Math.min(buffer.length, maxBytes - total);
    if (take > 0) { chunks.push(buffer.subarray(0, take)); total += take; }
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks, total);
}

/** DNS lookup that refuses any non-public answer; the socket connects to the validated address (no second resolution). */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(Object.assign(new Error("Canvas host resolved to a non-public address"), { code: "ENOTPUBLIC" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

export const httpsTransport: CanvasTransport = (input) => new Promise<TransportResponse>((resolve, reject) => {
  const request = httpsRequest(input.url, {
    method: input.method, headers: input.headers, lookup: publicOnlyLookup, signal: AbortSignal.timeout(input.timeoutMs),
    // Never follow redirects: node:https does not, and the caller inspects 3xx itself.
  }, (response) => {
    const declared = Number(response.headers["content-length"]);
    if (input.truncate) {
      readCapped(response, input.maxBytes).then((body) => { response.destroy(); resolve({ status: response.statusCode ?? 0, headers: response.headers, body }); }, (error) => { response.destroy(); reject(error); });
      return;
    }
    if (Number.isFinite(declared) && declared > input.maxBytes) { response.destroy(); reject(new CanvasResponseTooLargeError()); return; }
    readBounded(response, input.maxBytes).then((body) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }), (error) => { response.destroy(); reject(error); });
  });
  request.on("error", reject);
  if (input.body !== undefined) request.write(input.body);
  request.end();
});

// ---------------------------------------------------------------- results

export type CanvasApiResult = {
  ok: boolean; status: number; authRequired: boolean; data?: unknown;
  rateLimitRemaining?: number; retryAfterSeconds?: number;
  /** Validated same-origin path for rel="next", when Canvas sent a Link header. */
  nextPath?: string; hasLinkHeader: boolean;
};

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

export function nextPathFromLink(link: string | undefined, canvasOrigin: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;(.*)/.exec(part.trim());
    if (!match || !/rel="?([^";]*\s)?next(\s[^";]*)?"?/i.test(match[2])) continue;
    try {
      const url = new URL(match[1], canvasOrigin);
      if (url.origin !== new URL(canvasOrigin).origin) return undefined;
      return validateCanvasApiPath(`${url.pathname}${url.search}`);
    } catch { return undefined; }
  }
  return undefined;
}

/** 401, any redirect toward a login/SSO page, or an HTML page from the JSON API means the cookies are no longer accepted. */
export function isAuthFailure(status: number, headers: IncomingHttpHeaders, canvasOrigin: string, body?: Buffer): boolean {
  // Canvas also answers *permission* denials with 401 ({"status":"unauthorized"}, "user not
  // authorized to perform that action"), e.g. an endpoint a student may not call. Only an
  // "unauthenticated" 401 (or an unreadable one) means the cookies stopped working.
  if (status === 401) return !isPermissionDenial401(body);
  if (status >= 300 && status < 400) {
    const location = headerValue(headers, "location");
    if (!location) return false;
    try {
      const target = new URL(location, canvasOrigin);
      return target.origin !== new URL(canvasOrigin).origin || /^\/login(\/|$|\?)/.test(target.pathname) || target.pathname.startsWith("/saml") || target.pathname.startsWith("/sso");
    } catch { return true; }
  }
  const type = headerValue(headers, "content-type") ?? "";
  return status >= 200 && status < 300 && /text\/html/i.test(type);
}

/** True only for Canvas's JSON permission-denied 401 body; anything else stays an auth failure. */
export function isPermissionDenial401(body?: Buffer): boolean {
  if (!body?.length) return false;
  try {
    const parsed = JSON.parse(body.toString("utf8").replace(/^while\(1\);/, "")) as { status?: unknown };
    return parsed?.status === "unauthorized";
  } catch { return false; }
}

export function interpretResponse(response: TransportResponse, canvasOrigin: string): CanvasApiResult {
  const authRequired = isAuthFailure(response.status, response.headers, canvasOrigin, response.body);
  const type = headerValue(response.headers, "content-type") ?? "";
  let data: unknown = null;
  if (!authRequired && /json/i.test(type)) {
    const text = response.body.toString("utf8").replace(/^while\(1\);/, "");
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  } else if (!authRequired && response.body.length) data = response.body.toString("utf8").slice(0, 2000);
  const remaining = Number(headerValue(response.headers, "x-rate-limit-remaining"));
  const retryAfter = Number(headerValue(response.headers, "retry-after"));
  const link = headerValue(response.headers, "link");
  return {
    ok: response.status >= 200 && response.status < 300 && !authRequired, status: response.status, authRequired, data,
    rateLimitRemaining: headerValue(response.headers, "x-rate-limit-remaining") !== undefined && Number.isFinite(remaining) ? remaining : undefined,
    retryAfterSeconds: headerValue(response.headers, "retry-after") !== undefined && Number.isFinite(retryAfter) ? retryAfter : undefined,
    nextPath: nextPathFromLink(link, canvasOrigin), hasLinkHeader: Boolean(link),
  };
}

// ---------------------------------------------------------------- state store + health stats

/** `version` is an opaque token (the stored IV, unique per encryption) used for compare-and-swap. */
export type EncryptedStateRecord = { state: EncryptedBrowserState; version: string };
export interface EncryptedStateStore {
  load(): Promise<EncryptedStateRecord | null>;
  /** Persist only if the stored version is still `expectedVersion`. */
  compareAndSwap(next: EncryptedBrowserState, expectedVersion: string): Promise<boolean>;
}

export type CanvasCallStats = {
  calls: number; ok: number; authRequired: number; errors: number; lastStatus: number | null; rotatedNames: string[]; lastOkAt: Date | null; firstAuthFailureAt: Date | null;
  /** Count of responses that re-issued `_normandy_session`. */
  sessionCookieReissues: number;
  /** The jar currently holds `pseudonym_credentials` (name only). */
  rememberCookiePresent: boolean;
  /** A response re-issued `pseudonym_credentials`, or issued a session cookie while the previous one was absent/expired. */
  rememberCookieUsed: boolean;
};

export type TouchResult = { status: number; sessionCookieReissued: boolean; rotatedNames: string[]; authRequired: boolean };

export interface CanvasApi {
  request(request: CanvasRequest): Promise<CanvasApiResult>;
}

export type CanvasSessionClientOptions = {
  ownerId: string; canvasOrigin: string; store: EncryptedStateStore;
  transport?: CanvasTransport; now?: () => number; maxResponseBytes?: number; maxTotalBytes?: number; maxInFlight?: number; timeoutMs?: number;
};

export class CanvasSessionClient implements CanvasApi {
  private jar: StoredBrowserState | null = null;
  private version = "";
  private pending: CookieUpdate[] = [];
  private persisting: Promise<void> | null = null;
  private dirty = false;
  private bytes = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly rotated = new Set<string>();
  private rotatedThisCall = new Set<string>();
  private readonly counters = { calls: 0, ok: 0, authRequired: 0, errors: 0 };
  private lastStatus: number | null = null;
  private lastOkAt: Date | null = null;
  private firstAuthFailureAt: Date | null = null;
  private sessionCookieReissues = 0;
  private rememberCookieUsed = false;
  private readonly transport: CanvasTransport;
  private readonly now: () => number;

  constructor(private readonly options: CanvasSessionClientOptions) {
    this.transport = options.transport ?? httpsTransport;
    this.now = options.now ?? Date.now;
  }

  private async state(): Promise<StoredBrowserState> {
    if (this.jar) return this.jar;
    const record = await this.options.store.load();
    if (!record) throw new BridgeError("CANVAS_SESSION_EXPIRED", "No saved Canvas session is available. Sign in to Canvas again.", 401);
    this.jar = this.decrypt(record.state); this.version = record.version;
    return this.jar;
  }

  /**
   * The cookies a browser would send to the Canvas origin, for installing into the owner's own
   * browser via the Grove extension. Origin-scoped (cookiesForRequest), so IdP/Duo cookies and any
   * other host's cookies are never included. Callers must be the authenticated owner.
   */
  async exportBrowserCookies(): Promise<StoredCookie[]> {
    const origin = new URL(this.options.canvasOrigin);
    if (origin.protocol !== "https:") throw new BridgeError("CANVAS_ORIGIN_INVALID", "The Canvas origin must be https.", 400);
    const jar = await this.state();
    return cookiesForRequest(jar.cookies, new URL("/", origin), this.now());
  }

  private decrypt(state: EncryptedBrowserState): StoredBrowserState {
    let value: unknown;
    try { value = envelopeDecryptBrowserState(state, this.options.ownerId); }
    catch { throw new BridgeError("CANVAS_SESSION_EXPIRED", "The saved Canvas session cannot be read. Sign in to Canvas again.", 401); }
    const record = value && typeof value === "object" ? value as { cookies?: unknown; origins?: unknown } : {};
    return { ...record, cookies: Array.isArray(record.cookies) ? record.cookies as StoredCookie[] : [], origins: Array.isArray(record.origins) ? record.origins : [] };
  }

  private async acquire() {
    const limit = this.options.maxInFlight ?? MAX_IN_FLIGHT;
    while (this.active >= limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  private release() { this.active -= 1; this.waiters.shift()?.(); }

  async request(request: CanvasRequest): Promise<CanvasApiResult> {
    const url = canvasApiUrl(this.options.canvasOrigin, request.path);
    await this.acquire();
    try {
      const jar = await this.state();
      const headers: Record<string, string> = { accept: "application/json", "user-agent": CANVAS_USER_AGENT };
      const cookies = cookiesForRequest(jar.cookies, url, this.now());
      const hadSessionCookie = cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
      if (cookies.length) headers.cookie = cookieHeader(cookies);
      if (request.method !== "GET") { const token = csrfToken(cookies); if (token) headers["x-csrf-token"] = token; }
      const body = request.body === undefined ? undefined : JSON.stringify(request.body);
      if (body !== undefined) headers["content-type"] = "application/json";
      const remainingBudget = (this.options.maxTotalBytes ?? MAX_CLIENT_BYTES) - this.bytes;
      if (remainingBudget <= 0) throw new CanvasResponseTooLargeError();
      this.counters.calls += 1;
      let response: TransportResponse;
      try {
        response = await this.transport({ url, method: request.method, headers, body, timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS, maxBytes: Math.min(this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES, remainingBudget) });
      } catch (error) {
        this.counters.errors += 1;
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("CANVAS_UNREACHABLE", "Canvas could not be reached from the server.", 503);
      }
      this.bytes += response.body.length;
      this.absorbCookies(response, url, hadSessionCookie);
      const result = interpretResponse(response, this.options.canvasOrigin);
      this.lastStatus = result.status;
      if (result.ok) { this.counters.ok += 1; this.lastOkAt = new Date(this.now()); }
      else if (result.authRequired) { this.counters.authRequired += 1; this.firstAuthFailureAt ??= new Date(this.now()); }
      else this.counters.errors += 1;
      return result;
    } finally { this.release(); }
  }

  /**
   * One request to an allowlisted Classic quiz player route (see
   * validateQuizWebPath). Same cookie selection, UA, DNS pinning, no-redirect
   * and Set-Cookie persistence as API calls; bodies are capped at
   * QUIZ_WEB_MAX_BYTES and form fields are URL-encoded here.
   */
  async webRequest(request: QuizWebRequest): Promise<QuizWebResult> {
    const url = canvasQuizWebUrl(this.options.canvasOrigin, request.method, request.path);
    if (request.method === "GET" && (request.form?.length || request.authenticityToken)) throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas quiz GET requests carry no form body", 400);
    if (request.form?.some(([name]) => name === "authenticity_token")) throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "The CSRF token is added by the client only", 400);
    await this.acquire();
    try {
      const jar = await this.state();
      const json = request.accept === "json";
      const headers: Record<string, string> = { accept: json ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml", "user-agent": CANVAS_USER_AGENT };
      if (json) headers["x-requested-with"] = "XMLHttpRequest";
      const cookies = cookiesForRequest(jar.cookies, url, this.now());
      const hadSessionCookie = cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
      if (cookies.length) headers.cookie = cookieHeader(cookies);
      let body: string | undefined;
      if (request.method !== "GET") {
        const token = csrfToken(cookies);
        if (token) headers["x-csrf-token"] = token;
        const fields = [...(request.form ?? [])];
        if (request.authenticityToken) {
          if (!token) throw new BridgeError("CANVAS_SESSION_EXPIRED", "Canvas did not provide a CSRF token for this session. Sign in to Canvas again.", 401);
          fields.splice(fields[0]?.[0] === "utf8" ? 1 : 0, 0, ["authenticity_token", token]);
        }
        body = new URLSearchParams(fields).toString();
        headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        headers.origin = url.origin;
      }
      const remainingBudget = (this.options.maxTotalBytes ?? MAX_CLIENT_BYTES) - this.bytes;
      if (remainingBudget <= 0) throw new CanvasResponseTooLargeError();
      this.counters.calls += 1;
      let response: TransportResponse;
      try {
        response = await this.transport({ url, method: request.method, headers, body, timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS, maxBytes: Math.min(QUIZ_WEB_MAX_BYTES, remainingBudget) });
      } catch (error) {
        this.counters.errors += 1;
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("CANVAS_UNREACHABLE", "Canvas could not be reached from the server.", 503);
      }
      this.bytes += response.body.length;
      this.absorbCookies(response, url, hadSessionCookie);
      const result = interpretQuizWebResponse(response, this.options.canvasOrigin);
      this.lastStatus = result.status;
      if (result.authRequired) { this.counters.authRequired += 1; this.firstAuthFailureAt ??= new Date(this.now()); }
      else if (result.status >= 200 && result.status < 400) { this.counters.ok += 1; this.lastOkAt = new Date(this.now()); }
      else this.counters.errors += 1;
      return result;
    } finally { this.release(); }
  }

  /**
   * One cookie-authenticated GET to a Canvas file download route (validateFileDownloadPath).
   * Same cookie selection, UA, DNS pinning and Set-Cookie persistence as API calls. Redirects are
   * NOT followed: the absolute Location (Canvas's signed file URL) is returned for a cookie-less
   * fetch. A redirect to login/SSO is an expired session. At most FILE_REDIRECT_BODY_CAP is read.
   */
  async fileRedirect(path: string): Promise<FileRedirectResult> {
    const origin = new URL(this.options.canvasOrigin);
    if (origin.protocol !== "https:" || origin.origin !== this.options.canvasOrigin.replace(/\/$/, "")) throw new BridgeError("CANVAS_ORIGIN_INVALID", "The Canvas origin must be an exact https origin.", 400);
    const url = new URL(validateFileDownloadPath(path), origin);
    if (url.origin !== origin.origin || `${url.pathname}${url.search}` !== path) throw new BridgeError("CANVAS_PATH_NOT_ALLOWED", "Canvas file request path is not allowed", 400);
    await this.acquire();
    try {
      const jar = await this.state();
      const headers: Record<string, string> = { accept: "*/*", "user-agent": CANVAS_USER_AGENT };
      const cookies = cookiesForRequest(jar.cookies, url, this.now());
      const hadSessionCookie = cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
      if (cookies.length) headers.cookie = cookieHeader(cookies);
      this.counters.calls += 1;
      let response: TransportResponse;
      try {
        response = await this.transport({ url, method: "GET", headers, timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS, maxBytes: FILE_REDIRECT_BODY_CAP, truncate: true });
      } catch (error) {
        this.counters.errors += 1;
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("CANVAS_UNREACHABLE", "Canvas could not be reached from the server.", 503);
      }
      this.absorbCookies(response, url, hadSessionCookie);
      const raw = headerValue(response.headers, "location");
      const redirect = response.status >= 300 && response.status < 400;
      // Signed in, Canvas hands off to its file CDN (e.g. *.canvas-user-content.com with sf_verifier).
      // Signed out, it redirects to /login (or an SSO host). isAuthFailure() treats every off-origin
      // redirect as SSO, so files use their own rule.
      let target: URL | null = null;
      try { target = redirect && raw ? new URL(raw, origin) : null; } catch { target = null; }
      const handOff = Boolean(target && target.protocol === "https:" && (target.origin === origin.origin ? !/^\/login/.test(target.pathname) : FILE_HANDOFF_HOST.test(target.hostname)));
      const authRequired = response.status === 401 ? !isPermissionDenial401(response.body) : redirect && !handOff;
      const location = handOff && target ? target.toString() : null;
      this.lastStatus = response.status;
      if (authRequired) { this.counters.authRequired += 1; this.firstAuthFailureAt ??= new Date(this.now()); }
      else if (location) { this.counters.ok += 1; this.lastOkAt = new Date(this.now()); }
      else this.counters.errors += 1;
      return { status: response.status, authRequired, location };
    } finally { this.release(); }
  }

  /**
   * Load the Canvas dashboard page (`GET /`, fixed path) the way a browser tab
   * would, to see whether HTML page loads re-issue the session cookie. Same
   * cookie selection, UA, DNS pinning and no-redirect rules as API calls; at
   * most TOUCH_BODY_CAP_BYTES of the body are read and then discarded.
   */
  async touchSession(): Promise<TouchResult> {
    const origin = new URL(this.options.canvasOrigin);
    if (origin.protocol !== "https:" || origin.origin !== this.options.canvasOrigin.replace(/\/$/, "")) throw new BridgeError("CANVAS_ORIGIN_INVALID", "The Canvas origin must be an exact https origin.", 400);
    const url = new URL("/", origin);
    await this.acquire();
    try {
      const jar = await this.state();
      const headers: Record<string, string> = { accept: "text/html", "user-agent": CANVAS_USER_AGENT };
      const cookies = cookiesForRequest(jar.cookies, url, this.now());
      const hadSessionCookie = cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
      if (cookies.length) headers.cookie = cookieHeader(cookies);
      this.counters.calls += 1;
      const reissuesBefore = this.sessionCookieReissues;
      this.rotatedThisCall = new Set();
      let response: TransportResponse;
      try {
        response = await this.transport({ url, method: "GET", headers, timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS, maxBytes: TOUCH_BODY_CAP_BYTES, truncate: true });
      } catch (error) {
        this.counters.errors += 1;
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("CANVAS_UNREACHABLE", "Canvas could not be reached from the server.", 503);
      }
      this.absorbCookies(response, url, hadSessionCookie);
      const location = headerValue(response.headers, "location");
      // A 3xx is auth-required only when it points at login/SSO; any other redirect is not followed and not a success.
      const authRequired = response.status === 401 || (response.status >= 300 && response.status < 400 && isAuthFailure(response.status, response.headers, this.options.canvasOrigin) && location !== undefined);
      const ok = response.status >= 200 && response.status < 300;
      this.lastStatus = response.status;
      if (authRequired) { this.counters.authRequired += 1; this.firstAuthFailureAt ??= new Date(this.now()); }
      else if (ok) { this.counters.ok += 1; this.lastOkAt = new Date(this.now()); }
      else this.counters.errors += 1;
      return { status: response.status, sessionCookieReissued: this.sessionCookieReissues > reissuesBefore, rotatedNames: [...this.rotatedThisCall].sort(), authRequired };
    } finally { this.release(); }
  }

  private absorbCookies(response: TransportResponse, url: URL, hadSessionCookie: boolean) {
    const raw = response.headers["set-cookie"];
    const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const updates = headers.map((header) => parseSetCookie(header, url, this.now())).filter((item): item is CookieUpdate => item !== null)
      // Only cookies the Canvas host itself would store are ever kept.
      .filter((update) => domainMatches(url.hostname.toLowerCase(), update.cookie.domain));
    const issued = (name: string) => updates.some((update) => update.cookie.name === name && !update.remove);
    // Schools differ: older Canvas uses `_normandy_session`, newer (e.g. UF) uses `canvas_session`.
    if (SESSION_COOKIE_NAMES.some(issued)) {
      this.sessionCookieReissues += 1;
      if (!hadSessionCookie) this.rememberCookieUsed = true;
    }
    if (issued(REMEMBER_COOKIE)) this.rememberCookieUsed = true;
    if (!updates.length || !this.jar) return;
    const before = new Map(this.jar.cookies.map((cookie) => [cookieKey(cookie), cookie.value]));
    const changed = updates.filter((update) => update.remove ? before.has(cookieKey(update.cookie)) : before.get(cookieKey(update.cookie)) !== update.cookie.value);
    for (const update of updates) { this.rotated.add(update.cookie.name); this.rotatedThisCall.add(update.cookie.name); }
    if (!changed.length) return;
    this.jar = { ...this.jar, cookies: mergeCookies(this.jar.cookies, changed) };
    this.pending.push(...changed);
    void this.persist().catch(() => undefined);
  }

  /** Single writer per client; concurrent rotations coalesce into the next write. */
  private persist(): Promise<void> {
    if (this.persisting) { this.dirty = true; return this.persisting; }
    this.persisting = (async () => {
      try {
        do { this.dirty = false; await this.writeOnce(); } while (this.dirty);
      } finally { this.persisting = null; }
    })();
    return this.persisting;
  }

  private async writeOnce() {
    for (let attempt = 0; attempt < 4 && this.pending.length && this.jar; attempt += 1) {
      const included = this.pending.length;
      const encrypted = envelopeEncryptBrowserState(this.jar, this.options.ownerId);
      if (await this.options.store.compareAndSwap(encrypted, this.version)) {
        this.version = encrypted.iv; this.pending.splice(0, included); return;
      }
      // Another writer (app call, keepalive) rotated first: rebase our updates on theirs.
      const latest = await this.options.store.load();
      if (!latest) return;
      const base = this.decrypt(latest.state);
      this.jar = { ...base, cookies: mergeCookies(base.cookies, this.pending) }; this.version = latest.version;
    }
  }

  /** Wait until every observed rotation is durably stored. */
  async flush(): Promise<void> {
    for (let round = 0; round < 3 && (this.persisting || (this.pending.length && this.jar)); round += 1) {
      await (this.persisting ?? this.persist());
    }
  }

  stats(): CanvasCallStats {
    return {
      ...this.counters, lastStatus: this.lastStatus, rotatedNames: [...this.rotated].sort(), lastOkAt: this.lastOkAt, firstAuthFailureAt: this.firstAuthFailureAt,
      sessionCookieReissues: this.sessionCookieReissues, rememberCookieUsed: this.rememberCookieUsed,
      rememberCookiePresent: Boolean(this.jar?.cookies.some((cookie) => cookie.name === REMEMBER_COOKIE && !(cookie.expires > 0 && cookie.expires * 1000 <= this.now()))),
    };
  }
}
