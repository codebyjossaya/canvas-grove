import { lookup as dnsLookup } from "node:dns/promises";
import { isValidCanvasLoginPath, normalizeCanvasOrigin, normalizeInstitutionHostname } from "./institution";
import { isPublicAddress } from "./network-policy";

export const SSO_DISCOVERY_USER_AGENT = "CanvasGrove-SSO-Discovery/1.0 (server-side institution sign-in host discovery; no credentials)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type LookupFn = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export type SsoDiscoveryOptions = {
  fetch?: typeof fetch;
  lookup?: LookupFn;
  timeoutMs?: number;
  maxRedirects?: number;
};

export type SsoDiscoveryResult = {
  /** Exact hostnames seen off the Canvas origin, in redirect order. Each was HTTPS, credential/port-free and public-only at discovery time. */
  hosts: string[];
  /**
   * Off-origin hosts whose final (non-redirect) 2xx response looked like Canvas,
   * e.g. a vanity domain bouncing to `school.instructure.com`. These are already
   * in `hosts` (every validated hop is kept) so the hosted browser can follow
   * the Canvas-to-Canvas handoff; they are reported separately for logging.
   * The session's canvasOrigin is NOT rewritten: the user-confirmed origin stays
   * the identity the monitor checks.
   */
  canvasHosts: string[];
  complete: boolean;
};

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function looksLikeCanvas(response: Response, url: URL): boolean {
  return url.hostname.endsWith(".instructure.com") || response.headers.has("x-canvas-meta") || response.headers.has("x-request-context-id");
}

/**
 * Follow the institution's Canvas login link with manual redirects (no cookies,
 * no credentials) to learn which SSO hosts the hosted browser will need.
 * Never throws: failure returns whatever was safely collected so far, and
 * callers fall back to their existing rules.
 */
export async function discoverSsoHosts(canvasOriginInput: string, loginPath: string, options: SsoDiscoveryOptions = {}): Promise<SsoDiscoveryResult> {
  const result: SsoDiscoveryResult = { hosts: [], canvasHosts: [], complete: false };
  const doFetch = options.fetch ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("SSO discovery timed out")), { once: true }));
  deadline.catch(() => undefined);

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
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await Promise.race([doFetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { "user-agent": SSO_DISCOVERY_USER_AGENT, accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
      }), deadline]);
      try { await response.body?.cancel(); } catch { /* body is never read */ }
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.ok && current.origin !== canvasOrigin && looksLikeCanvas(response, current)) result.canvasHosts.push(current.hostname);
        result.complete = true;
        break;
      }
      if (hop >= maxRedirects) break; // redirect budget spent: do not trust or collect a further hop
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
        if (!result.hosts.includes(host)) result.hosts.push(host);
      }
      current = next;
    }
  } catch {
    // Timeouts, network errors and bad input all degrade to "nothing more discovered".
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return result;
}
