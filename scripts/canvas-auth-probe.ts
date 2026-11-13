// Read-only probe: GET requests for one hosted session (any status), printing only
// HTTP status and Canvas's JSON `status` field — never cookie or token values.
//   docker exec canvas-grove-sync-worker-1 npx tsx scripts/canvas-auth-probe.ts <session-id-prefix> [/api/v1/path ...]
import process from "node:process";
import postgres from "postgres";
import { CanvasSessionClient } from "../lib/canvas/session-client";
import { sqlEncryptedStateStore } from "../lib/canvas/session-store-sql";
import { devOwnerId } from "../lib/dev/dev-owner";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const prefix = (process.argv[2] ?? "").toLowerCase();
if (!/^[0-9a-f-]{6,36}$/.test(prefix)) throw new Error("Pass a hosted session id prefix");
const paths = process.argv.slice(3).length ? process.argv.slice(3) : ["/api/v1/users/self"];
async function tenant<T>(ownerId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${ownerId}, true)`; return work(tx); });
}
function safeFields(data: unknown) {
  const pick = (o: Record<string, unknown>) => ({ id: o.id, started_at: o.started_at, finished_at: o.finished_at, end_at: o.end_at, has_validation_token: typeof o.validation_token === "string" ? true : undefined, locked_for_user: o.locked_for_user, workflow_state: o.workflow_state, attempt: o.attempt, published: o.published, lock_at: o.lock_at, unlock_at: o.unlock_at, allowed_attempts: o.allowed_attempts, one_question_at_a_time: o.one_question_at_a_time, cant_go_back: o.cant_go_back, quiz_type: o.quiz_type, has_access_code: o.has_access_code, ip_filter: o.ip_filter ? "set" : undefined,
    // Non-secret metadata for comparing synced rows against live Canvas.
    posted_at: o.posted_at, created_at: o.created_at, updated_at: o.updated_at, due_at: o.due_at, context_code: o.context_code, course_id: o.course_id, type: o.type, score: o.score, graded_at: o.graded_at, last_message_at: o.last_message_at, announcement_id: o.announcement_id });
  if (Array.isArray(data)) return { count: data.length, ...(process.env.PROBE_IDS ? { ids: data.map((row) => (row as Record<string, unknown>)?.id) } : {}), ...(data[0] && typeof data[0] === "object" ? pick(data[0] as Record<string, unknown>) : {}) };
  const o = (data ?? {}) as Record<string, unknown>;
  if (Array.isArray(o.quiz_submissions)) return { submissions: (o.quiz_submissions as Record<string, unknown>[]).map(pick) };
  return pick(o);
}
async function main() {
  for (const owner of [{ id: devOwnerId() }]) { // only ever the developer's own account
    const rows = await tenant(owner.id, (tx) => tx<{ id: string; status: string; canvas_origin: string }[]>`
      select s.id,s.status,p.canvas_origin from hosted_browser_sessions s join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
      where s.owner_id=${owner.id} and s.revoked_at is null and s.id::text like ${`${prefix}%`}`);
    for (const target of rows) {
      const client = new CanvasSessionClient({ ownerId: owner.id, canvasOrigin: target.canvas_origin, store: sqlEncryptedStateStore((work) => tenant(owner.id, work), owner.id, target.id, { requireActive: false }) });
      for (const path of paths) {
        const r = await client.request({ method: "GET", path });
        const body = r.data && typeof r.data === "object" ? r.data as Record<string, unknown> : {};
        console.log(JSON.stringify({ session: target.id.slice(0, 8), dbStatus: target.status, path: path.replace(/\d{3,}/g, "<id>"), http: r.status, authRequired: r.authRequired, canvasStatus: body.status ?? null, canvasMessage: Array.isArray(body.errors) ? String((body.errors as Record<string, unknown>[])[0]?.message ?? "").slice(0, 160) : undefined, ...safeFields(r.data) }));
      }
      await client.flush();
    }
  }
  await sql.end();
}
main().catch((e) => { console.error("probe failed:", e instanceof Error ? e.message : "unknown"); process.exitCode = 1; });
