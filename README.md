# Canvas Grove

A self-hosted web app that wraps Canvas LMS. Grove keeps each user's Canvas browser session
encrypted on the server, syncs courses, assignments, quizzes, pages and files into Postgres, and
presents them in its own theme. Built with Next.js (App Router), Clerk for sign-in, Drizzle and
Postgres, and a hosted-Chromium service used only for the interactive Canvas sign-in.

> Private project. Written against UF's Canvas (`ufl.instructure.com`); other schools are untested.

## What is in here

| Path | What |
| --- | --- |
| `app/`, `components/`, `lib/` | The Next.js app, API routes, sync, views, Canvas clients |
| `lib/canvas/` | Cookie-session Canvas client, file and equation proxy |
| `lib/views/` | Canvas HTML sanitizing and link rewriting, view loaders |
| `scripts/` | Sync worker and developer-only probes |
| `services/browser-orchestrator/`, `browser/` | Hosted Chromium used for Canvas sign-in |
| `drizzle/` | SQL migrations |
| `extension/` | "Grove for Canvas" browser extension (see below) |
| `tests/` | Unit and integration tests |
| `docs/`, `SELF_HOSTING.md` | Operations and network-security notes |

## Running it

Secrets live in untracked env files (`.env.local`, `.env.docker`); `.env.example` lists the
variables. The reference deployment is a homelab running `next dev`, the sync worker and the
orchestrator under Docker Compose with bind mounts. Use the wrapper rather than raw compose:

```bash
./homelab-compose.sh up -d
```

Database access for development goes through `./ops-psql.sh`, which runs as the unprivileged app
role with row-level security scoped to the developer's own account (`.dev-owner`, untracked).
Read `CLAUDE.md` before writing any script that acts as a user.

## Browser extension

Canvas refuses to launch LTI tools (Gradescope, MATLAB) and New Quizzes for cookie-based sessions,
so those can only run inside Canvas in a real browser. The extension installs the Canvas session
Grove holds into your own browser when you click a Canvas link in Grove. Install steps and the
trade-offs are in [`extension/README.md`](extension/README.md); built zips are attached to the
`extension-v*` releases.
