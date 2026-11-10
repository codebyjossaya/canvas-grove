import { lookup as dnsLookup } from "node:dns/promises";
import { DEFAULT_CANVAS_LOGIN_PATH, isValidCanvasLoginPath, MAX_INSTITUTION_AUTH_HOSTS, normalizeCanvasOrigin, normalizeInstitutionHostname } from "./institution";
import { isPublicAddress } from "./network-policy";
import { discoverSsoHosts } from "./sso-discovery";

export const HOST_DISCOVERY_USER_AGENT = "CanvasGrove-Host-Discovery/1.0 (server-side institution sign-in host discovery; no credentials)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_BODY_BYTES = 512 * 1024;
export const MAX_FOLLOWED_LOGIN_LINKS = 6;

type LookupFn = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export type HostDiscoverySettings = {
  fetch?: typeof fetch;
  lookup?: LookupFn;
  /** Overall budget for the whole discovery, including every followed link. */
  timeoutMs?: number;
  maxRedirects?: number;
};

export type HostDiscoveryResult = {
  /** Exact public hostnames seen off the Canvas origin, in discovery order; at most MAX_INSTITUTION_AUTH_HOSTS. */
  hosts: string[];
  /** Canvas login paths scraped from the final page and followed (at most MAX_FOLLOWED_LOGIN_LINKS). */
  loginPaths: string[];
};

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/**
 * Canvas provider login paths linked from an HTML page (Canvas's own login page
 * or an institution "choose how to sign in" page such as a school portal).
 * Only anchors on the Canvas host itself survive; `http:` links to that exact
 * host are upgraded to `https:` (Canvas 301s them anyway). Other hosts — even
 * other Canvas tenants — other schemes, credentials, ports and non-provider
 * paths are ignored. Exported for tests.
 */
export function extractCanvasLoginPaths(html: string, pageUrl: string, canvasOrigin: string): string[] {
  const canvasHost = new URL(canvasOrigin).hostname;
  const paths: string[] = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const anchor = /<a\b([^>]*)>/gi;
  for (let match = anchor.exec(source); match; match = anchor.exec(source)) {
    const href = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(match[1]);
    if (!href) continue;
    let url: URL;
    try { url = new URL(decodeEntities(href[1] ?? href[2] ?? href[3] ?? "").trim(), pageUrl); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (url.username || url.password || url.port || url.hostname !== canvasHost) continue;
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (path === DEFAULT_CANVAS_LOGIN_PATH || !isValidCanvasLoginPath(path) || paths.includes(path)) continue;
    paths.push(path);
  }
  return paths;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += Math.min(value.byteLength, room);
    if (size >= maxBytes) { await reader.cancel().catch(() => undefined); break; }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Learn every host the hosted browser needs for a school's sign-in, starting at
 * `<canvas>/<loginPath>` (normally plain `/login`) with manual redirects, no
 * cookies and no credentials:
 *  1. every validated off-origin hop of that chain (e.g. an institution portal
 *     page, or the IdP Canvas redirects to directly);
 *  2. if the chain ends on an HTML page, the Canvas provider links on it
 *     (at most six) are each followed with `discoverSsoHosts` and their IdP
 *     hosts are added.
 * Each host is shape-checked and must resolve only to public addresses before
 * it is fetched or returned. Never throws: failures, timeouts and bad input
 * return whatever was collected, so session creation is never blocked.
 */
export async function discoverInstitutionHosts(canvasOriginInput: string, loginPath: string = DEFAULT_CANVAS_LOGIN_PATH, settings: HostDiscoverySettings = {}): Promise<HostDiscoveryResult> {
  const result: HostDiscoveryResult = { hosts: [], loginPaths: [] };
  const doFetch = settings.fetch ?? fetch;
  const lookup = settings.lookup ?? defaultLookup;
  const maxRedirects = settings.maxRedirects ?? 5;
  const budgetMs = settings.timeoutMs ?? 10_000;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Host discovery timed out")), { once: true }));
  deadline.catch(() => undefined);
  const addHost = (host: string) => {
    if (result.hosts.length < MAX_INSTITUTION_AUTH_HOSTS && !result.hosts.includes(host)) result.hosts.push(host);
  };
  const resolvesPublicOnly = async (hostname: string) => {
    try {
      const addresses = await Promise.race([lookup(hostname), deadline]);
      return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
    } catch { return false; }
  };

  try {
    const canvasOrigin = normalizeCanvasOrigin(canvasOriginInput);
    if (!isValidCanvasLoginPath(loginPath)) return result;
    let current = new URL(loginPath, canvasOrigin);
    let page: string | null = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await Promise.race([doFetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { "user-agent": HOST_DISCOVERY_USER_AGENT, accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
      }), deadline]);
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.ok && /text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
          page = await Promise.race([readCapped(response, MAX_BODY_BYTES), deadline]);
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
        break;
      }
      await response.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects) break;
      const location = response.headers.get("location");
      if (!location) break;
      let next: URL;
      try { next = new URL(location, current); } catch { break; }
      if (next.protocol !== "https:" || next.username || next.password || next.port) break;
      if (next.origin !== canvasOrigin) {
        let host: string;
        try { host = normalizeInstitutionHostname(next.hostname); } catch { break; }
        // Resolve before we ever request it: never fetch, or allowlist, a host with private addresses.
        if (!await resolvesPublicOnly(host)) break;
        addHost(host);
      }
      current = next;
    }

    if (page !== null) {
      result.loginPaths = extractCanvasLoginPaths(page, current.toString(), canvasOrigin).slice(0, MAX_FOLLOWED_LOGIN_LINKS);
      const remaining = budgetMs - (Date.now() - startedAt);
      if (result.loginPaths.length && remaining > 0) {
        // Each chain has its own timeout bounded by the remaining budget and never
        // throws, so partial results from fast chains are kept.
        const chains = await Promise.all(result.loginPaths.map((path) =>
          discoverSsoHosts(canvasOrigin, path, { fetch: doFetch, lookup, timeoutMs: remaining, maxRedirects }).catch(() => ({ hosts: [] as string[] })),
        ));
        for (const chain of chains) for (const host of chain.hosts) addHost(host);
      }
    }
  } catch {
    // Timeouts, network errors and bad input all degrade to "nothing more discovered".
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return result;
}
