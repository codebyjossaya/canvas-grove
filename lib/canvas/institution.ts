import { isTrustedIdentityHost } from "./trusted-identity-hosts";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home", ".lan"];
const FORBIDDEN_HOSTS = new Set(["localhost", "localhost.localdomain", "0.0.0.0"]);

// Institution SSO handoffs cannot be inferred safely from a Canvas tenant name.
// Keep this list exact and reviewed: never derive `*.edu` wildcards from user input.
const REVIEWED_AUTH_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "https://ufl.instructure.com": ["elearning.ufl.edu", "login.ufl.edu"],
};
const RETIRED_BROAD_AUTH_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "https://ufl.instructure.com": ["ufl.edu"],
};

function normalizeHostname(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || !host.includes(".") || FORBIDDEN_HOSTS.has(host)) {
    throw new Error("Canvas must use a public HTTPS hostname");
  }
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error("Local and private hostnames are not allowed");
  }
  if (host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host) || !host.split(".").every((label) => HOST_LABEL.test(label))) {
    throw new Error("IP addresses and invalid hostnames are not allowed");
  }
  return host;
}

export function normalizeCanvasOrigin(value: unknown): string {
  const raw = String(value ?? "").trim();
  const candidate = raw && !raw.includes("://") ? `https://${raw}` : raw;
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new Error("Enter your school's Canvas HTTPS address"); }
  normalizeHostname(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Canvas must use a credential-free HTTPS address");
  }
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Enter the Canvas origin only, without a page path");
  return `https://${url.hostname.toLowerCase()}`;
}

export function normalizeInstitutionName(value: unknown, canvasOrigin: string): string {
  const supplied = String(value ?? "").replace(/\s+/g, " ").trim();
  if (supplied.length > 100) throw new Error("Institution name must be 100 characters or fewer");
  if (supplied) return supplied;
  const hostname = new URL(canvasOrigin).hostname;
  const first = hostname.endsWith(".instructure.com") ? hostname.slice(0, -".instructure.com".length) : hostname;
  return first.split(/[.-]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ").slice(0, 100) || "My institution";
}

export function normalizeAuthHostRules(value: unknown, canvasOrigin: string): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const canvasHost = new URL(canvasOrigin).hostname;
  const rules = entries.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => {
    const trimmed = entry.trim();
    let hostname = trimmed;
    if (trimmed.includes("://")) {
      const url = new URL(trimmed);
      if (url.protocol !== "https:" || url.username || url.password || url.port || (url.pathname !== "/" && url.pathname !== "")) {
        throw new Error("Sign-in domains must be HTTPS origins or public hostnames");
      }
      hostname = url.hostname;
    }
    // Institution rules are exact hosts. A wildcard used to be silently turned
    // into its bare parent (e.g. `*.duosecurity.com` -> `duosecurity.com`),
    // which matched nothing useful. Reject it with an actionable message;
    // common IdPs (Duo, Microsoft, Okta, Google...) are already built in.
    if (hostname.includes("*")) {
      throw new Error("Wildcard sign-in domains are not supported. Enter exact hostnames; Duo, Microsoft, Okta, Google and other common sign-in providers are already allowed.");
    }
    return normalizeHostname(hostname);
  }).filter((hostname) => hostname !== canvasHost);
  const normalizedOrigin = normalizeCanvasOrigin(canvasOrigin);
  const retired = new Set(RETIRED_BROAD_AUTH_HOSTS[normalizedOrigin] ?? []);
  const reviewed = REVIEWED_AUTH_HOSTS[normalizedOrigin] ?? [];
  const unique = [...new Set([...rules.filter((rule) => !retired.has(rule)), ...reviewed])];
  if (unique.length > 8) throw new Error("Use at most eight institution sign-in domains");
  return unique;
}

/**
 * Canvas authentication-provider login paths: `/login`, `/login/<provider>` and
 * `/login/<provider>/<numeric id>`. Mirrored (plain JS) in
 * services/browser-orchestrator/server.mjs; keep the two in sync.
 */
export const CANVAS_LOGIN_PATH_PATTERN = /^\/login(?:\/(?:saml|cas|openid_connect|microsoft|google|apple|linkedin|github|facebook|clever|ldap|canvas|instructure)(?:\/\d{1,12})?)?$/;
export const DEFAULT_CANVAS_LOGIN_PATH = "/login" as CanvasLoginPath;
export const MAX_INSTITUTION_AUTH_HOSTS = 8;

declare const canvasLoginPathBrand: unique symbol;
/** A string that passed `isValidCanvasLoginPath`. */
export type CanvasLoginPath = string & { readonly [canvasLoginPathBrand]: true };

export function isValidCanvasLoginPath(value: unknown): value is CanvasLoginPath {
  return typeof value === "string" && value.length <= 64 && CANVAS_LOGIN_PATH_PATTERN.test(value);
}

/** Coerce persisted/legacy values: keep a valid path as-is, otherwise fall back to `/login`. */
export function toCanvasLoginPath(value: unknown): CanvasLoginPath {
  return isValidCanvasLoginPath(value) ? value : DEFAULT_CANVAS_LOGIN_PATH;
}

/** Strict request validation: absent means `/login`; anything present must be a valid Canvas login path. */
export function requireCanvasLoginPath(value: unknown): CanvasLoginPath {
  if (value === undefined || value === null || value === "") return DEFAULT_CANVAS_LOGIN_PATH;
  if (!isValidCanvasLoginPath(value)) throw new Error("Unsupported Canvas sign-in path");
  return value;
}

/**
 * Parse the one link a user pastes: their school's Canvas SSO link
 * (`https://ufl.instructure.com/login/saml/355`), any Canvas page URL, or a bare
 * Canvas host. Only the origin and a validated Canvas login path survive; query
 * strings, fragments and non-login paths are dropped and never navigated to.
 */
export function parseInstitutionLink(input: unknown): { canvasOrigin: string; loginPath: CanvasLoginPath } {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > 2048) throw new Error("Paste your school's Canvas sign-in link or address");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new Error("Paste your school's Canvas sign-in link or address"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Canvas must use a credential-free HTTPS address");
  }
  const host = normalizeHostname(url.hostname);
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  return { canvasOrigin: `https://${host}`, loginPath: isValidCanvasLoginPath(path) ? path : DEFAULT_CANVAS_LOGIN_PATH };
}

/** Shape-check a hostname (no DNS): public-looking, not an IP, not a local suffix. */
export function normalizeInstitutionHostname(value: string): string {
  return normalizeHostname(value);
}

/**
 * Append automatically discovered SSO hosts after the user's/reviewed rules,
 * de-duplicated, never including the Canvas host, and capped so the stored list
 * never exceeds MAX_INSTITUTION_AUTH_HOSTS (excess discovered hosts are dropped,
 * never the user's own rules). Hosts already covered by the built-in trusted
 * identity-provider list are only added if room remains, so they never crowd
 * out an institution-specific host.
 */
export function mergeDiscoveredAuthHosts(rules: readonly string[], discovered: readonly string[], canvasOrigin: string): string[] {
  const canvasHost = new URL(canvasOrigin).hostname;
  const merged = [...new Set(rules)];
  const candidates = discovered.flatMap((value) => { try { return [normalizeHostname(value)]; } catch { return []; } })
    .filter((host) => host !== canvasHost);
  const ordered = [...candidates.filter((host) => !isTrustedIdentityHost(host)), ...candidates.filter(isTrustedIdentityHost)];
  for (const host of ordered) {
    if (merged.length >= MAX_INSTITUTION_AUTH_HOSTS) break;
    if (!merged.includes(host)) merged.push(host);
  }
  return merged;
}

export function isAllowedInstitutionUrl(value: string, canvasOrigin: string, authHostRules: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const canvas = normalizeCanvasOrigin(canvasOrigin);
    if (url.origin === canvas) return true;
    const host = normalizeHostname(url.hostname);
    // Institution rules: exact only. Built-in trusted IdPs: registrable-domain suffix.
    return authHostRules.some((rule) => host === rule) || isTrustedIdentityHost(host);
  } catch { return false; }
}
