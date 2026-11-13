// Read-only Canvas session-lifetime report (aggregate metadata only; no cookie
// names beyond the fixed health columns, no values, no headers).
//
//   docker exec canvas-grove-sync-worker-1 npx tsx scripts/session-health-report.ts [hosted-session-id-or-prefix]
//
// Without an argument it reports every non-revoked session.
import process from "node:process";
import postgres from "postgres";
import { formatDuration, summarizeHealth, type HealthEvent, type HealthKind, type HealthOutcome } from "../lib/canvas/session-health";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const filter = (process.argv[2] ?? "").toLowerCase();
if (filter && !/^[0-9a-f-]{4,36}$/.test(filter)) throw new Error("Pass a hosted session id or id prefix");
const sql = postgres(databaseUrl, { max: 1 });

const iso = (value: Date | null) => value ? value.toISOString() : "-";
const duration = (value: number | null) => value === null ? "-" : formatDuration(value);

async function main() {
  const owners = await sql<{ id: string }[]>`select id from users order by id`;
  let printed = 0;
  for (const owner of owners) {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${owner.id}, true)`;
      const sessions = await tx<{ id: string; status: string; failure_code: string | null; captured_at: Date | null }[]>`
        select s.id,s.status,s.failure_code,
          (select max(m.finished_at) from interactive_session_monitors m where m.owner_id=s.owner_id and m.hosted_session_id=s.id and m.status='succeeded') captured_at
        from hosted_browser_sessions s where s.owner_id=${owner.id} and s.revoked_at is null
          and (${filter} = '' or s.id::text like ${`${filter}%`}) order by s.created_at`;
      for (const session of sessions) {
        const rows = await tx<{ at: Date; kind: HealthKind; http_status: number | null; outcome: HealthOutcome; rotated: boolean; session_cookie_reissued: boolean; remember_cookie_present: boolean; remember_cookie_used: boolean; call_count: number; ok_count: number; auth_required_count: number; error_count: number; session_cookie_reissue_count: number }[]>`
          select at,kind,http_status,outcome,rotated,session_cookie_reissued,remember_cookie_present,remember_cookie_used,call_count,ok_count,auth_required_count,error_count,session_cookie_reissue_count
          from canvas_session_health_events where owner_id=${owner.id} and hosted_session_id=${session.id} order by at`;
        const report = summarizeHealth({ events: rows as HealthEvent[], capturedAt: session.captured_at, status: session.status, failureCode: session.failure_code, now: new Date() });
        printed += 1;
        console.log([
          `session ${session.id}`,
          `  status:                 ${report.status}${report.failureCode ? ` (${report.failureCode})` : ""}`,
          `  signed in (capture):    ${iso(report.capturedAt)}  (${duration(report.sinceCaptureMs)} ago)`,
          `  health rows:            ${report.events}`,
          `  canvas calls:           ${report.calls}  ok=${report.ok} auth_required=${report.authRequired} error=${report.errors}`,
          `  session-cookie rotations (rows): ${report.rotationCount}  last=${iso(report.lastRotationAt)}`,
          `  session-cookie reissue rate: ${report.sessionCookieReissueRate === null ? "-" : `${(report.sessionCookieReissueRate * 100).toFixed(1)}% of calls`}  longest gap=${duration(report.longestReissueGapMs)}`,
          `  remember-me cookie:     present=${report.rememberCookiePresent} used=${report.rememberCookieUsed}`,
          `  longest gap between ok: ${duration(report.longestOkGapMs)}`,
          `  last ok:                ${iso(report.lastOkAt)}`,
          `  longest ok session age: ${duration(report.longestOkSessionAgeMs)}`,
          report.expired ? `  EXPIRED: last ok ${iso(report.lastOkAt)} -> first auth failure ${iso(report.firstFailureAt)}; age at expiry ${duration(report.ageAtExpiryMs)}` : "  expired:                no",
          `  VERDICT: ${report.verdict}`,
        ].join("\n"));
      }
    });
  }
  if (!printed) console.log(filter ? `No session matches ${filter}` : "No sessions");
}

void main().catch((error) => { console.error("session-health-report failed:", error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => sql.end({ timeout: 5 }));
