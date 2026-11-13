// One-shot: a single `GET /` page keepalive for one session, recording a
// `page-keepalive` health event. Prints only status/booleans/cookie names.
//   docker exec canvas-grove-sync-worker-1 npx tsx scripts/page-touch-once.ts <hosted-session-id-prefix>
import process from "node:process";
import { devOwnerId } from "../lib/dev/dev-owner";
import postgres from "postgres";
import { CanvasSessionClient } from "../lib/canvas/session-client";
import { healthEventRow } from "../lib/canvas/session-health";
import { insertHealthEvent, sqlEncryptedStateStore } from "../lib/canvas/session-store-sql";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const prefix = (process.argv[2] ?? "").toLowerCase();
if (!/^[0-9a-f-]{6,36}$/.test(prefix)) throw new Error("Pass a hosted session id prefix");
const sql = postgres(databaseUrl, { max: 1 });
async function tenant<T>(ownerId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${ownerId}, true)`; return work(tx); });
}

async function main() {
  const owners = [{ id: devOwnerId() }]; // only ever the developer's own account
  for (const owner of owners) {
    const rows = await tenant(owner.id, (tx) => tx<{ id: string; canvas_origin: string }[]>`
      select s.id,p.canvas_origin from hosted_browser_sessions s join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
      where s.owner_id=${owner.id} and s.status='active' and s.revoked_at is null and s.id::text like ${`${prefix}%`}`);
    for (const target of rows) {
      const client = new CanvasSessionClient({ ownerId: owner.id, canvasOrigin: target.canvas_origin, store: sqlEncryptedStateStore((work) => tenant(owner.id, work), owner.id, target.id, { requireActive: true }) });
      const result = await client.touchSession();
      await client.flush();
      const row = healthEventRow(client.stats(), { ownerId: owner.id, hostedSessionId: target.id, kind: "page-keepalive" });
      if (row) await tenant(owner.id, (tx) => insertHealthEvent(tx, row));
      console.log(JSON.stringify({ session: target.id.slice(0, 8), at: new Date().toISOString(), status: result.status, sessionCookieReissued: result.sessionCookieReissued, rotatedNames: result.rotatedNames, authRequired: result.authRequired }));
    }
  }
  await sql.end();
}
main().catch((error) => { console.error("page-touch failed:", error instanceof Error ? error.message : "unknown"); process.exitCode = 1; });
