# Hosted-browser network boundary

Deployment is intentionally held until the independent security review passes.

## Scope: login only

The hosted browser exists only for interactive Canvas sign-in. When authentication succeeds, the cookie jar is captured, envelope-encrypted (AES-256-GCM, owner-bound AAD) and stored. The browser is then destroyed: the viewer is revoked and the container is terminated. No sync or app request ever runs inside a browser.

All later Canvas access uses a server-side API client authenticated by those cookies (`lib/canvas/session-client.ts`) and runs in the app and worker containers:

- It is restricted to the exact Canvas origin and `/api/v1/` paths.
- Only cookies whose RFC 6265 domain, path and secure attributes match the Canvas host are sent. IdP cookies never leave the jar.
- DNS is pinned to public addresses, redirects are never followed, and responses are size and time bounded.
- Rotated cookies are persisted with optimistic concurrency.
- A rejection marks the session `CANVAS_SESSION_EXPIRED` for re-login; no browser is restored.
- The value-free `canvas_session_health_events` log records outcomes and cookie names only.

## Planes

- `browser-orchestrator` is the only Docker-socket holder. It joins `backend` and the internal `browser-control` network, never a browser network. Its Docker inputs are fixed image, labels, resource limits, display dimensions, and generated session identifiers.
- `browser-relay` has no Docker socket. It joins `browser-control`; the orchestrator attaches it to a unique internal network for each claimed browser. It accepts only signed registrations where the target is exactly `canvas-browser-<session UUID>`.
- `browser-egress-proxy` has no Docker socket. It joins only the uplink; the orchestrator attaches it to each unique internal session network. Browsers have no uplink and Chromium is forced to use this proxy.
- Every warm browser remains on the internal quarantine network with no relay or proxy, so it has zero egress until claimed.

The per-session network prevents browsers from reaching one another. An internal network prevents direct public, host-gateway, metadata, backend, database, or orchestrator access. The only browser destination with an uplink is the pinned CONNECT proxy.

## Capabilities and egress

Relay capabilities are random, hashed in memory, short lived, kind-bound (`cdp` or `viewer`), session-bound, revocable, size/time/concurrency limited, and never logged. Viewer WebSockets require the configured exact external HTTPS origin; CDP explicitly permits no Origin and otherwise only the internal control origin. Viewer cookies and authorization headers are removed before the VNC upstream.

The egress proxy accepts HTTPS `CONNECT` to port 443 only. A signed, generation-bound registration maps the browser's current source IP to exact Canvas and institution-authentication hostnames. The proxy adds its built-in trusted identity-provider and egress-only lists, described below. Each connection resolves again, rejects any non-global answer (including mapped IPv6), and connects to the validated IP rather than resolving by hostname a second time. Registrations expire after 90 seconds and are renewed every 30 seconds. Replacement generations atomically remove old IP mappings; unregister is signed and generation checked.

The relay samples every top-level page/new tab throughout the lifetime. A disallowed destination revokes capabilities, closes sockets, unregisters egress, and sends only the sanitized hostname to the orchestrator. The orchestrator removes the container and retains a five-minute hostname-only tombstone.

## Host policy: exact rules, trusted identity providers, egress-only CDNs

Real university sign-ins hop through third-party SSO/MFA services whose hostnames are per tenant (Duo Universal Prompt `api-XXXXXXXX.duosecurity.com`, `<tenant>.okta.com`, and so on), so they cannot be listed exactly per institution. Three host classes are enforced consistently by the app (`isAllowedInstitutionUrl`), the orchestrator (`allowedInteractiveUrl`), the relay guard (`allowedNavigationUrl`) and the egress proxy (`egressHostAllowed`):

| Class | Matching | Top-level navigation | Egress CONNECT |
|---|---|---|---|
| Canvas origin + per-institution `authHostRules` (max 8, plus reviewed `REVIEWED_AUTH_HOSTS`) | exact host only | yes | yes |
| Built-in trusted identity providers | registrable-domain suffix: `host === s` or `host` ends with `"." + s` | yes | yes |
| Built-in egress-only subresource hosts | suffix, except the exact-only CloudFront/S3 entries | **no** (relay destroys the browser) | yes |

**Trusted identity providers** (do not count toward the eight user rules): `duosecurity.com` (Duo Universal Prompt), `microsoftonline.com`, `login.microsoft.com`, `login.windows.net`, `login.live.com` (Microsoft Entra ID and Microsoft account), `okta.com`, `oktapreview.com`, `okta-emea.com` (Okta production, sandbox and EMEA cells), `accounts.google.com` (Google Workspace SAML), `onelogin.com`, `pingone.com`, `pingone.eu`, `pingone.ca`, `pingone.asia`, `pingidentity.com` (PingOne regions, PingID and PingFederate cloud), `auth0.com` (Auth0 tenants), `cirrusidentity.com` (Cirrus Bridge, common in higher education), `seamlessaccess.org` (the SeamlessAccess federation discovery service that replaced the InCommon WAYF), `securid.com`, `login.instructure.com` and `sso.canvaslms.com` (Instructure Identity, e.g. USF, which hands off to the school IdP) (RSA SecurID Cloud Authentication Service).

**Egress-only subresource hosts**: exact `du11hjcvx0uqb.cloudfront.net` (Canvas Cloud static assets) and `instructure-uploads.s3.amazonaws.com` (Canvas theme and branding uploads). These are exact because CloudFront and S3 subdomains can be claimed by third parties, and S3 bucket names may contain dots. Suffix entries: `inscloudgate.net` (Instructure file service), `canvas-user-content.com` (Canvas sandboxed user content), `msauth.net`, `msftauth.net`, `msftauthimages.net`, `msauthimages.net` (Microsoft sign-in assets and tenant branding), `oktacdn.com` (Okta assets), `ssl.gstatic.com`, `www.gstatic.com` (Google sign-in assets), `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `ajax.googleapis.com`, `fonts.googleapis.com`, `fonts.gstatic.com` (public library and font CDNs referenced by institution login pages). Analytics and trackers (`googletagmanager.com`, `google-analytics.com`, etc.) are deliberately absent and stay blocked.

**Rules for user-entered hosts**: they are always exact. A wildcard such as `*.duosecurity.com` is rejected with an explanatory error; it used to be silently rewritten to the bare `duosecurity.com`. Suffix matching applies only to the reviewed built-in lists.

**Where the lists live**: the canonical copy is `services/browser-network-policy.mjs`, which is copied into both the relay and egress-proxy images. The orchestrator image is built from `./services/browser-orchestrator`, so it carries `navigation-policy.mjs`, a copy of the identity-provider list. The app has `lib/canvas/trusted-identity-hosts.ts`. `tests/trusted-host-policy.test.mjs` asserts that every copy is identical. To change a list, update all three copies in one reviewed change.

**Why the proxy holds the suffix lists itself**: the signed `/v1/register` schema is unchanged. The relay still registers only exact hosts (the Canvas host plus `authHostRules`), and a registration that includes `suffixes` is still rejected. The proxy combines those exact rules with the suffix lists built into its image. A compromised relay, or a leaked registration secret, therefore cannot widen egress to arbitrary suffixes. HMAC, nonce and generation checks are unchanged.

**Threat-model notes**:
- Top-level navigation is still limited to the Canvas origin, exact institution hosts and the trusted identity providers. Any other top-level page, including one on an egress-only CDN, revokes the session.
- Public-only DNS is still enforced on every CONNECT. Every answer must be a global address, and the proxy connects to the validated IP. This applies to suffix-matched hosts too.
- Residual risk: anyone can create a tenant on the multi-tenant identity providers (Okta, Auth0, OneLogin, Ping), so the remote browser can display an attacker-controlled branded login page. Scripts on such a page can still reach only allowed egress hosts. The public CDNs (jsDelivr, unpkg, cdnjs) serve arbitrary published packages, but they are read-only, so they offer no attacker-readable exfiltration channel. Both risks are accepted in exchange for working MFA and SSO, and the lists are kept to authentication and static-asset domains only.

## DOM-mirror sign-in renderer (`SIGNIN_RENDERER=mirror`, default `pixels`)

The optional renderer shows the remote sign-in page as sanitized HTML instead of the noVNC pixel stream. Page scripts run only in the remote Chromium.

- **Capture.** `mirror/capture.js` runs in a CDP isolated world (page scripts cannot see it) and serializes the DOM, shadow roots, adopted sheets, input state (never password or one-time-code values, only "empty/non-empty"; secret = `type=password`, `-webkit-text-security` masking, or an `autocomplete`/`name`/`id` matching `SECRET_FIELD_PATTERN`, and it stays secret if a "show password" toggle changes its type), focus, scroll, dialogs and canvas bitmaps. Out-of-process iframes are reached through `Target.setAutoAttach`. Only frames with the same effective origin as the top-level page are mirrored (about:blank/srcdoc inherit; data:/blob: are opaque); cross-origin iframe contents never leave the orchestrator, and a visible one (>= 2500 px^2, not hidden) switches the page to the pixel viewer (`frame`). A top-level page that is not mirrorable is sent as `blank` (with `landed: 1` for the signed-in Canvas page, which is never shown); a non-landed blank falls back to pixels after 2.5 s.
- **Sanitizer allowlist** (`viewer/mirror-protocol.js`, applied on the server and re-checked in the viewer). Tags are allowlisted (HTML/SVG lists); `script`, `noscript`, `template`, `object`, `embed`, `base`, `meta`, `title`, `math`, `foreignObject`, SVG animation and hidden inputs are dropped with their subtree. Attributes are allowlisted; every `on*`, `srcdoc`, `action`/`formaction`/`method`, `target`, `ping`, `http-equiv`, `is`, `sandbox`, `contenteditable`, `autofocus` and password `value` is removed. Links lose `href` (clicks are replayed remotely). Any value carrying `javascript:`/`vbscript:`/`data:` (except image/font data) or similar schemes is dropped. CSS `expression()`, `behavior`, `-moz-binding` are neutralized. Covered by `tests/mirror-protocol.test.mjs`.
- **Sandbox/CSP.** The mirror document (`/viewer/<id>/m/frame.html`) is served with `script-src 'none'`, `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, and `sandbox allow-same-origin`; the iframe has `sandbox="allow-same-origin"` without `allow-scripts`, so no script can run in it. `allow-same-origin` is kept on purpose so the trusted viewer script can build the DOM directly; without `allow-scripts` and with `script-src 'none'` this grants nothing to page content. The live test asserts that injected `<script>` and `onerror` do not execute.
- **Subresource proxy.** All URLs become opaque per-generation tokens under `/viewer/<id>/m/r/<token>` (viewer-cookie authenticated). Bytes come from the remote browser's own cache (`Page.getResourceContent`) or are loaded by the remote browser (`Network.loadNetworkResource`), so they pass the same egress proxy and host policy; the orchestrator never fetches them itself, and the user's browser never contacts IdP/Canvas hosts. Media types are sniffed (images/fonts only), CSS is re-rewritten, responses carry `nosniff`, `sandbox` CSP and CORP `same-origin`. Limits: 5 MB per resource, 60 MB and 600 resources per document, 40 MB cache.
- **Input authorization.** `POST /viewer/<id>/m/input` requires the viewer grant cookie, a same-origin `Origin`/`Sec-Fetch-Site`, JSON, at most 16 KB, and passes `validateInputMessage` (click/focus/input/select/Enter/Escape/Tab/scroll/viewport only). Messages for a stale document generation are ignored. Rate limit: 40 events/s per session (token bucket). At most 2 mirror streams per session; slow consumers (>32 MB buffered) are disconnected.
- **Size limits and fallback.** 30,000 nodes, 4 MB snapshot, depth 256, 64 KB per attribute, 512 KB text, 2 MB CSS, 8 KB input values. Exceeding a limit, a serialization error, a CAPTCHA (reCAPTCHA/hCaptcha/Turnstile) or a canvas-heavy page switches that page to the pixel viewer; the next navigation returns to the mirror. The user can also switch to the classic view.
- **Override.** `?renderer=` on `/live` is honoured only with `SIGNIN_RENDERER_OVERRIDE=allow` (dev/test); the default is `deny`.

## Required configuration

Generate three distinct values of at least 32 random bytes:

- `BROWSER_ORCHESTRATOR_SECRET`: app/worker to orchestrator API.
- `BROWSER_RELAY_CONTROL_SECRET`: orchestrator to relay and relay callback.
- `BROWSER_EGRESS_REGISTRATION_SECRET`: relay to egress proxy registration.

`BROWSER_PUBLIC_BASE_URL` must be the exact external HTTPS origin used by the browser. Plain HTTP is accepted only for `localhost`/`127.0.0.1` development. Live links returned to the app are relative same-origin `/live/...` links.

For the current Tailscale deployment set it exactly to `https://canvas-grove.tail8dc4e4.ts.net`. Both the orchestrator and relay fail startup when the value is unset, includes a path, or is remote plain HTTP; this is intentional because secure viewer cookies and WebSocket Origin validation depend on an exact HTTPS origin.

## Health and restart behavior

Relay `/health` exposes only readiness and a random process epoch. The orchestrator detects a new epoch, checks each registry container through Docker, recreates its isolated network attachment, and idempotently re-registers only running owned sessions. Missing containers are pruned. The egress proxy is repopulated by the relay heartbeat after restart. During either outage, access fails closed. The proxy keeps registrations only in memory, so it must not crash on socket errors: an unhandled EPIPE from a closed tunnel used to restart it, which blanked in-flight IdP pages (CDN requests denied at stage `client`) until the next heartbeat.

## Rollback

Do not roll back by reconnecting the orchestrator to a shared browser network. If the release fails review, keep the current deployed image unchanged. To roll back after a future rollout, stop new session creation, revoke live grants, terminate managed browser containers through the orchestrator, deploy the last reviewed application/Compose bundle, and require users to reconnect Canvas. Never reuse relay capabilities, egress generations, or browser profile plaintext.
