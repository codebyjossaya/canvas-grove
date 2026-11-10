// Orchestrator copy of the reviewed trusted identity-provider list. The
// orchestrator image is built from ./services/browser-orchestrator and cannot
// import services/browser-network-policy.mjs, so this list is duplicated.
// tests/trusted-host-policy.test.mjs asserts every copy is identical:
//   services/browser-network-policy.mjs (canonical; relay + egress proxy)
//   services/browser-orchestrator/navigation-policy.mjs (this file)
//   lib/canvas/trusted-identity-hosts.ts (app)
// Egress-only CDN hosts are intentionally NOT here: they are never navigable.
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

/** Registrable-domain suffix match against the built-in list (dot boundary). */
export function isTrustedIdentityHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return Boolean(h) && TRUSTED_IDENTITY_PROVIDER_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Interactive top-level navigation: exact Canvas origin, exact institution rules, or a trusted IdP. */
export function allowedInteractiveUrl(value, canvasOrigin, authHostRules) {
  try {
    const url = new URL(value); const canvas = new URL(canvasOrigin);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.origin === canvas.origin || authHostRules.some((rule) => host === rule) || isTrustedIdentityHost(host));
  } catch { return false; }
}
