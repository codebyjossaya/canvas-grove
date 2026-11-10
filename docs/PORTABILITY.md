# Canvas Grove portability and restore runbook

Treat application images, the PostgreSQL logical backup, and secrets as separate transfer streams. Never package `.env*`, Clerk claim files, live-view URLs, browser tokens, or raw browser profile volumes with source artifacts.

## Transfer set

- Push immutable image digests to a private registry, or transfer `docker save` archives with SHA-256 checksums.
- Take a consistent custom-format PostgreSQL logical backup during a write pause and encrypt it before transfer.
- Re-enter secrets from a secret manager. Preserve the Clerk application binding, orchestrator HMAC secret, and the exact browser-state KEK and key ID. A changed/lost KEK makes encrypted Canvas snapshots intentionally unrecoverable.
- Transfer non-secret configuration: institution origins, auth host rules, login paths, public viewer origin, retention, and worker concurrency.

Do not copy `browser_profiles` or `browser_orchestrator_state`; they are ephemeral. Durable browser authentication is the envelope-encrypted PostgreSQL snapshot. Do not transfer `postgres_data` across PostgreSQL major versions or architectures.

## Export and SSH transfer

1. Run `npm run migration:preflight` and `npm run migration:manifest`; retain the manifest and excluded-secret list.
2. Record image digests, commit, migration level, Docker/Compose versions, architecture, and PostgreSQL major version.
3. Stop web and worker writers for the dump, leave PostgreSQL healthy, and use `pg_dump --format=custom`. Resume the source after a rehearsal.
4. Encrypt the dump with an approved recipient-based tool. Verify the SSH destination host key and compare SHA-256 checksums after transfer.
5. Keep the source intact through destination acceptance.

## Restore and verify

1. Run destination preflight. Create fresh volumes and a private control network; never publish PostgreSQL or orchestrator control ports.
2. Load images by digest and supply secrets from the secret manager. Do not copy a working `.env` in the bundle.
3. Start PostgreSQL, restore roles/schema/data, run migrations, and verify RLS plus the least-privilege app role.
4. Start orchestrator, worker, app, then gateway. The worker resumes durable cursors/jobs; runtime browsers are recreated only when needed.
5. Verify authenticated owner isolation, origin validation, one encrypted session restore, viewer/control-route isolation, sync freshness, lease recovery, orphan reconciliation, and restart recovery.
6. Cut over DNS/Tailscale only after acceptance. Never run two production writers against divergent databases.

## Rollback

Stop destination writers and reverse the gateway/DNS cutover to the untouched source. Preserve destination evidence. If the source was retired, restore the encrypted logical dump into a new volume; never overwrite the only database copy.

## University-neutral and SSRF boundaries

Every account stores its HTTPS Canvas origin, institution label, login path, and suffix-scoped SSO/MFA hosts. Origins cannot contain credentials, ports, paths, IP literals, local/private-shaped names, or non-HTTPS schemes. Canvas and auth names must resolve exclusively to public addresses before entering the browser allowlist. Runtime navigation is limited to those names.

DNS checks are defense in depth. Production egress policy should also prevent browser containers from reaching loopback, RFC1918, link-local, Docker control networks, and cloud metadata endpoints.
