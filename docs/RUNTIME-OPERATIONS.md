# Browser and continuous-sync operations

PostgreSQL is authoritative. Browser containers, live grants, and the orchestrator registry are replaceable runtime material.

## The browser is login-only

The hosted browser exists only during an interactive sign-in. When Canvas accepts the user, the shared finalizer (`lib/bridge/complete-authentication.ts`, used by the `/confirm` route and the durable auth monitor) stores the envelope-encrypted cookie jar. The winning caller then destroys the browser with `releaseLoginBrowser`: it revokes the live viewer, then terminates the container. An `active` session therefore has no browser. Reconciliation no longer protects one, and any leftover is reclaimed after the orphan grace period.

The browser never makes sync or app requests, and no provider has an `execute` method. Nothing provisions or "restores" a browser for an active session.

## Direct Canvas API (sync, app, keepalive)

Every Canvas call goes through `lib/canvas/session-client.ts`, a server-side client authenticated by cookies:

- It decrypts the stored jar for each client (one per job or request batch). It sends only cookies that RFC 6265 domain, path, secure and expiry rules select for the Canvas host. IdP and other-host cookies are never sent.
- It calls only `${canvasOrigin}/api/v1/...`: same origin, no `//`, `\`, dot segments or encoded separators. Requests go over `node:https` with a DNS lookup pinned to public addresses, never follow redirects, time out after 20 s, and send a descriptive `User-Agent` and `Accept: application/json`.
- Non-GET requests send `X-CSRF-Token`, taken from the URL-decoded `_csrf_token` cookie.
- It reads `Set-Cookie` on every response, including the re-issued `_normandy_session` that carries Canvas's sliding `expire_after`. Rotations are merged into the jar, re-encrypted, and persisted by compare-and-swap on the stored IV. A concurrent writer is rebased, never overwritten. Session cookies without an expiry are kept.
- A 401, a redirect to login or SSO, or an HTML page from the JSON API counts as `authRequired`. The session becomes `auth_required`/`CANVAS_SESSION_EXPIRED`, its policies pause, and the UI asks the user to sign in again. There is no browser restore.
- Memory is bounded: 100 rows per page, at most 10 pages per collection (followed by `Link: rel="next"`), 8 MiB per response, 96 MiB per client, and 4 requests in flight per client.

## Session health and keepalive

`canvas_session_health_events` (tenant-scoped with RLS) receives one row per sync job, app request, keepalive and recovery check. A row holds counts, the last HTTP status, the outcome, the names of rotated cookies and booleans (`session_cookie_reissued`, `remember_cookie_present`, `remember_cookie_used`). It never holds cookie values or headers.

The worker sends `GET /api/v1/users/self` for each active session when no Canvas call has been recorded for `CANVAS_KEEPALIVE_MINUTES` (default 10, clamped to 1–19, below the 20-minute institution minimum). The keepalive persists rotations like any other call.

Report (read-only, aggregate):

    docker exec canvas-grove-sync-worker-1 npx tsx scripts/session-health-report.ts [session-id-or-prefix]

## Actionable states

- `CANVAS_SESSION_EXPIRED`: Canvas rejected the stored cookies. Sync for the account pauses until the user signs in again.
- `BROWSER_SESSION_NOT_FOUND` on an `auth_required` session that has a stored jar is a legacy state left by browser-backed sync. On startup the worker probes the jar once over the direct API (`lib/canvas/session-recovery.ts`). Success reactivates the session and resumes its jobs. A rejection becomes `CANVAS_SESSION_EXPIRED`. Transient errors are retried at most every 5 minutes. The interactive monitor still never re-enqueues for this code (anti-churn).
- `BROWSER_STARTING`, `BROWSER_UNRESPONSIVE`, `BROWSER_HOST_OFFLINE`: apply only to an interactive sign-in browser.

## Continuous sync

The independent worker claims database-leased jobs, heartbeats, persists cursors and freshness, and applies bounded backoff. Each claimed job is bound to the account's current active session. While no active session exists, jobs wait queued without using attempts. Per-account concurrency avoids self-races. Worker restart reclaims expired leases without resetting cursors.

## Orphan reconciliation

The worker signs the set of provider UUIDs that the database still owns for sign-in, covering `provisioning`, `auth_required` and `failed` sessions, and sends it to the orchestrator. Registry and DB-owned names are always protected. Canonical unowned containers are deleted only after the configured grace. Ambiguous legacy names stay quarantined unless an exact audited migration list is supplied. Never use label-wide deletion.

After recovery, verify service health, sync freshness, and `canvas_session_health` log lines with `outcome: "ok"`.
