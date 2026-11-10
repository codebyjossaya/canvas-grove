import { isIP } from "node:net";

/** Denies every non-global range used by the relay and the pinned egress proxy. */
export function isPublicAddress(value) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = isIP(value);
  if (family === 4) {
    const number = value.split(".").map(Number).reduce((x, part) => ((x << 8) + part) >>> 0, 0);
    const inRange = (base, bits) => { const start = base.split(".").map(Number).reduce((x, part) => ((x << 8) + part) >>> 0, 0); const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0; return (number & mask) === (start & mask); };
    return ![["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]].some(([base,bits]) => inRange(base,bits));
  }
  if (family === 6) { const normalized = value.toLowerCase(); return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd") && !/^fe[89ab]/.test(normalized) && !normalized.startsWith("ff") && !normalized.startsWith("2001:db8:"); }
  return false;
}

// ---------------------------------------------------------------------------
// Built-in host policy (reviewed). See docs/BROWSER_NETWORK_SECURITY.md.
//
// TRUSTED_IDENTITY_PROVIDER_SUFFIXES: third-party SSO/MFA providers whose
// per-tenant subdomains (e.g. api-XXXXXXXX.duosecurity.com, <tenant>.okta.com)
// cannot be enumerated per institution. Allowed for top-level navigation AND
// egress. Matched by registrable-domain suffix: host === s || host ends with
// "." + s. These never count toward the eight per-institution rules, and
// user-entered rules are ALWAYS exact (never suffix matched).
//
// Copies that MUST stay identical (asserted by tests/trusted-host-policy.test.mjs):
//   services/browser-network-policy.mjs (relay + egress proxy images)
//   services/browser-orchestrator/navigation-policy.mjs (orchestrator image)
//   lib/canvas/trusted-identity-hosts.ts (app)
export const TRUSTED_IDENTITY_PROVIDER_SUFFIXES = Object.freeze([
  "duosecurity.com",
  "microsoftonline.com",
  "login.microsoft.com",
  "login.windows.net",
  "login.live.com",
  "okta.com",
  "oktapreview.com",
  "okta-emea.com",
  "accounts.google.com",
  "onelogin.com",
  "pingone.com",
  "pingone.eu",
  "pingone.ca",
  "pingone.asia",
  "pingidentity.com",
  "auth0.com",
  "cirrusidentity.com",
  "seamlessaccess.org",
  "securid.com",
  // Instructure Identity (Canvas-hosted login used by e.g. USF): per-tenant
  // <uuid>.<region>.login.instructure.com, which hands off to sso.canvaslms.com.
  "login.instructure.com",
  "sso.canvaslms.com",
]);

// EGRESS_ONLY_SUFFIXES: static subresource hosts needed to render Canvas and
// IdP login pages. Allowed for HTTPS CONNECT in the egress proxy ONLY; a
// top-level page on one of these hosts is still blocked by the relay guard,
// the orchestrator and the app. Analytics/trackers (googletagmanager.com,
// google-analytics.com, ...) are deliberately absent and stay blocked.
export const EGRESS_ONLY_SUFFIXES = Object.freeze([
  // Instructure / Canvas Cloud (see EGRESS_ONLY_EXACT_HOSTS for the CDN/S3 hosts)
  "inscloudgate.net",
  "canvas-user-content.com",
  // Identity-provider asset CDNs
  "msauth.net",
  "msftauth.net",
  "msftauthimages.net",
  "msauthimages.net", // aadcdn.msauthimages.net: Entra tenant branding (observed live on USF login)
  "oktacdn.com",
  "ssl.gstatic.com",
  "www.gstatic.com",
  // Public library / font CDNs referenced by institution login pages
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

// Hosts on shared provider domains where a subdomain could be claimed by a
// third party (S3 bucket names may contain dots; CloudFront is shared), so
// these are matched EXACTLY, never as suffixes. Egress only.
export const EGRESS_ONLY_EXACT_HOSTS = Object.freeze([
  "du11hjcvx0uqb.cloudfront.net",
  "instructure-uploads.s3.amazonaws.com",
]);

const normalizeHost = (value) => String(value || "").toLowerCase().replace(/\.$/, "");

/** Registrable-domain suffix match: exact host or a true subdomain (dot boundary). */
export function hostMatchesSuffix(host, suffixes) {
  const h = normalizeHost(host);
  return Boolean(h) && suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

export const isTrustedIdentityHost = (host) => hostMatchesSuffix(host, TRUSTED_IDENTITY_PROVIDER_SUFFIXES);

/** Top-level navigation: exact per-session rules or a built-in trusted IdP. */
export function navigationHostAllowed(host, exactRules) {
  const h = normalizeHost(host);
  return (exactRules instanceof Set ? exactRules.has(h) : [...exactRules].includes(h)) || isTrustedIdentityHost(h);
}

/** Egress CONNECT: navigation-allowed hosts plus the egress-only subresource CDNs. */
export function egressHostAllowed(host, exactRules) {
  return navigationHostAllowed(host, exactRules) || EGRESS_ONLY_EXACT_HOSTS.includes(normalizeHost(host)) || hostMatchesSuffix(host, EGRESS_ONLY_SUFFIXES);
}

/** Relay top-level URL check: exact Canvas origin, exact institution host, or trusted IdP. */
export function allowedNavigationUrl(value, canvasOrigin, authHostRules) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    return u.origin === canvasOrigin || navigationHostAllowed(u.hostname, authHostRules);
  } catch { return false; }
}

/**
 * Sign-in has handed back to Canvas: a top-level https page on the exact Canvas
 * origin whose path is outside /login (SAML/OIDC callbacks live under /login/...
 * and then redirect to / or /?login_success=1).
 */
export function canvasLanded(value, canvasOrigin) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    if (u.origin !== new URL(canvasOrigin).origin) return false;
    return !/^\/login(?:\/|$)/i.test(u.pathname);
  } catch { return false; }
}
