# Canvas Grove — project rules

## Other people's data: never act as another user
The homelab DB holds **several Grove users**, including other people's live Canvas sessions. Acting on one of them means logging into Canvas as someone else (this happened once, 2026-11-11).

- The developer's own account is the owner id in `.dev-owner` at the repo root on the homelab (`~/projects/canvas/web/my-clerk-next-app/.dev-owner`). That's the **only** account any script, probe, browser session or query may act as.
- **DB queries:** use `./ops-psql.sh` (repo root on the homelab). It runs as `canvas_grove_app` with forced row-level security and `app.user_id` = `.dev-owner`, so it only sees the developer's rows. Pass `</dev/null` when it's used inside a heredoc script, because it reads stdin. **Don't** query tenant tables as the superuser (`psql -U $POSTGRES_USER`), which bypasses RLS. Use the superuser only for schema/catalog work or when the user explicitly asks, and never to pick a session to act on.
- **Dev scripts** that act as a user (Canvas requests, hosted browsers, cookie jars) must use `devOwnerId()` / `assertDevOwner()` from `lib/dev/dev-owner.ts` and never loop over `select id from users`. Already guarded: `scripts/quiz-flow-recorder.ts`, `scripts/canvas-auth-probe.ts`, `scripts/page-touch-once.ts`.
- If a task seems to need another owner's session or data, **stop and ask**. Don't assume a session is the user's because it's active, recent or matches a school.

## Where the code runs
The source of truth is the homelab dev server (`ssh jossaya@jc-homelab`, fish login shell, so pipe `bash -s <<'EOF'`). This Windows checkout is stale. See the memory notes for deploy details.
