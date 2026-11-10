// App copy of the reviewed trusted identity-provider list used for top-level
// navigation checks. Must stay identical to:
//   services/browser-network-policy.mjs (canonical; relay + egress proxy)
//   services/browser-orchestrator/navigation-policy.mjs (orchestrator)
// (asserted by tests/trusted-host-policy.test.mjs). Egress-only CDN hosts are
// intentionally absent: they are never valid top-level pages.
export const TRUSTED_IDENTITY_PROVIDER_SUFFIXES: readonly string[] = Object.freeze([
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

/** Registrable-domain suffix match (dot boundary). Only for this built-in list, never user rules. */
export function isTrustedIdentityHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return Boolean(h) && TRUSTED_IDENTITY_PROVIDER_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}
