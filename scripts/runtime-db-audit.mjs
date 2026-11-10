import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rls = await sql`
    select relname as table, relrowsecurity as enabled, relforcerowsecurity as forced
    from pg_class
    where relname in ('user_preferences','hosted_browser_sessions','canvas_accounts','sync_policies','sync_jobs','interactive_session_monitors')
    order by relname`;
  const monitors = await sql`
    select status, coalesce(last_observed_state, '') as observed, coalesce(last_error_code, '') as error, count(*)::int as count
    from interactive_session_monitors group by status,last_observed_state,last_error_code order by status,last_observed_state`;
  const jobs = await sql`select status, count(*)::int as count from sync_jobs group by status order by status`;
  const policies = await sql`select status, count(*)::int as count from sync_policies group by status order by status`;
  const sessions = await sql`select status, coalesce(failure_code, '') as failure, count(*)::int as count from hosted_browser_sessions group by status,failure_code order by status,failure_code`;
  console.log(JSON.stringify({ rls, monitors, jobs, policies, sessions }));
} finally {
  await sql.end();
}
