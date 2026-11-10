import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required (use a disposable database only)");
const sql = postgres(url, { max: 8 });
const appUrl = new URL(url); appUrl.username = "qa_app"; appUrl.password = "qa-app-only";
const appSql = postgres(appUrl.toString(), { max: 16 });

test.after(async () => { await appSql.end(); await sql.end(); });

test("manual sync is owner scoped and concurrent starts are durably single-flight", async () => {
  await sql.unsafe(`
    create type sync_job_status as enum ('queued','leased','running','succeeded','failed','cancelled');
    create table users(id uuid primary key, clerk_user_id text not null unique);
    create table sync_jobs(
      id uuid primary key, owner_id uuid not null references users(id), canvas_account_id uuid not null,
      kind text not null, scope jsonb not null default '{}', status sync_job_status not null default 'queued',
      dedupe_key text, run_after timestamptz not null default now(), finished_at timestamptz, error_code text
    );
    create unique index sync_jobs_active_dedupe_unique on sync_jobs(owner_id,dedupe_key)
      where status in ('queued','leased','running') and dedupe_key is not null;
    alter table sync_jobs enable row level security; alter table sync_jobs force row level security;
    create policy tenant_isolation on sync_jobs using(owner_id=nullif(current_setting('app.user_id',true),'')::uuid)
      with check(owner_id=nullif(current_setting('app.user_id',true),'')::uuid);
    create role qa_app login password 'qa-app-only' nosuperuser nobypassrls;
    grant usage on schema public to qa_app; grant select,insert,update on sync_jobs to qa_app;
  `);
  const ownerA = "11111111-1111-4111-8111-111111111111", ownerB = "22222222-2222-4222-8222-222222222222";
  const accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await sql`insert into users values(${ownerA},'clerk-a'),(${ownerB},'clerk-b')`;
  const start = async () => appSql.begin(async tx => {
    await tx`select set_config('app.user_id',${ownerA},true)`;
    return tx`insert into sync_jobs(id,owner_id,canvas_account_id,kind,scope,dedupe_key)
      values(gen_random_uuid(),${ownerA},${accountA},'courses',${tx.json({reason:"manual_sync"})},${accountA+":courses"})
      on conflict do nothing returning id`;
  });
  const starts = await Promise.all(Array.from({length:12},start));
  assert.equal(starts.flat().length,1,"only one concurrent start may queue the active resource job");
  await appSql.begin(async tx => {
    await tx`select set_config('app.user_id',${ownerB},true)`;
    assert.equal((await tx`select * from sync_jobs`).length,0,"another Clerk owner cannot poll the job");
  });
  await appSql.begin(async tx => {
    await tx`select set_config('app.user_id',${ownerA},true)`;
    const [queued] = await tx`select status,scope from sync_jobs`;
    assert.equal(queued.status,"queued"); assert.equal(queued.scope.reason,"manual_sync");
    await tx`update sync_jobs set status='running' where id=${starts.flat()[0].id}`;
    assert.equal((await tx`select status from sync_jobs`)[0].status,"running");
    await tx`update sync_jobs set status='succeeded',finished_at=now() where id=${starts.flat()[0].id}`;
    assert.equal((await tx`select status,finished_at from sync_jobs`)[0].status,"succeeded");
  });
  assert.equal((await start()).length,1,"completion releases the partial unique index for an explicit retry");
});
