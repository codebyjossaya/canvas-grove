# Self-host Canvas Grove

Canvas Grove runs as four services on a private Compose network: the app,
PostgreSQL, a one-shot migration job, and the local browser orchestrator. Only
the app is published, on `127.0.0.1` by default.

## First start

1. Generate private configuration. Existing files are never replaced and
   generated values are not printed:

   ```bash
   node scripts/bootstrap-self-hosted.mjs
   ```

2. Add the Clerk publishable and secret keys to `.env.docker`. Never commit or
   share this file.
3. Validate and start:

   ```bash
   docker compose --env-file .env.docker config --quiet
   docker compose --env-file .env.docker up --build -d
   docker compose --env-file .env.docker ps
   ```

4. Open `http://localhost:3000` on the host. For authenticated access from
   another device, use a trusted HTTPS reverse proxy. The jc-homelab
   deployment's canonical tailnet-only URL is
   `https://canvas-grove.tail8dc4e4.ts.net/`; the raw LAN endpoint remains
   available for non-authenticated diagnostics only because Clerk's secure
   session cookies cannot be set on a raw HTTP IP address.

   On jc-homelab the host's nginx already owns :443, so the URL is served by
   the `tailscale` sidecar in `compose.homelab.yaml` (config and state in
   `~/apps/canvas-grove-tailscale`, auth key in `ts.env` there). Run compose
   through `./homelab-compose.sh`.

The migration job must succeed before the app starts. Future `up --build -d`
runs pending migrations before replacing the app.

## Operations and safety

```bash
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100 app migrate browser-orchestrator postgres
```

The `postgres_data` and `browser_profiles` volumes are durable. Normal
`docker compose down` preserves them. Never use `down -v` unless you intend to
destroy all database and browser-profile data.

The default bind is loopback-only. Use a TLS reverse proxy and configure the
Clerk production domain for remote access. Never expose PostgreSQL, the browser
orchestrator, CDP endpoints, or live-control tokens. Database records contain
only internal runtime/profile references and token hashes or secret references,
not raw CDP or live-view URLs.
