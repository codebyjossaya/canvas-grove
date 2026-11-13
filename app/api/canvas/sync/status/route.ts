import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { withTenantTransaction } from "@/lib/db";
import { syncCursors, syncJobs } from "@/lib/db/schema";
import { errorJson, json } from "@/lib/bridge/http";
import { syncPolicies, type SyncKind } from "@/lib/sync/catalog";
import { enqueueManualSync } from "@/lib/sync/manual";

export async function POST() {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  try {
    const ctx = await ensureUserForClerk(session.userId);
    const result = await enqueueManualSync(ctx);
    if (result.state === "not-connected") return json({ ...result, error: "Connect Canvas before starting a sync.", code: "CANVAS_NOT_CONNECTED" }, 409);
    if (result.state === "auth-required") return json({ ...result, error: "Canvas sign-in is required before syncing.", code: "BROWSER_AUTH_EXPIRED" }, 401);
    if (result.state === "not-initialized") return json({ ...result, error: "Sync is still being initialized. Retry shortly.", code: "SYNC_NOT_READY" }, 425);
    return json(result, result.queued ? 202 : 200);
  } catch (error) { return errorJson(error); }
}

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  const ctx = await ensureUserForClerk(session.userId);
  const result = await withTenantTransaction(ctx.ownerId, async (tx) => {
    const cursors = await tx.select({ canvasAccountId: syncCursors.canvasAccountId, resourceType: syncCursors.resourceType, scopeKey: syncCursors.scopeKey, lastSuccessAt: syncCursors.lastSuccessAt, lastAttemptAt: syncCursors.lastAttemptAt, consecutiveFailures: syncCursors.consecutiveFailures, lastErrorCode: syncCursors.lastErrorCode }).from(syncCursors).where(eq(syncCursors.ownerId, ctx.ownerId));
    const recentJobs = await tx.select({ id: syncJobs.id, canvasAccountId: syncJobs.canvasAccountId, kind: syncJobs.kind, status: syncJobs.status, attempt: syncJobs.attempt, runAfter: syncJobs.runAfter, finishedAt: syncJobs.finishedAt, errorCode: syncJobs.errorCode, scope: syncJobs.scope }).from(syncJobs).where(and(eq(syncJobs.ownerId, ctx.ownerId))).orderBy(desc(syncJobs.createdAt)).limit(50);
    return { cursors, recentJobs };
  });
  const now = Date.now();
  return json({
    resources: result.cursors.map((cursor) => {
      const policy = syncPolicies[cursor.resourceType as SyncKind];
      const lastSuccessAt = cursor.lastSuccessAt?.toISOString() ?? null;
      return { accountId: cursor.canvasAccountId, kind: cursor.resourceType, scope: cursor.scopeKey, lastSuccessAt, lastAttemptAt: cursor.lastAttemptAt?.toISOString() ?? null, consecutiveFailures: cursor.consecutiveFailures, errorCode: cursor.lastErrorCode, freshness: !cursor.lastSuccessAt ? "never" : policy && now - cursor.lastSuccessAt.getTime() > policy.staleAfterMs ? "stale" : "fresh" };
    }),
    jobs: result.recentJobs.map((job) => ({ id: job.id, accountId: job.canvasAccountId, kind: job.kind, status: job.status, attempt: job.attempt, runAfter: job.runAfter.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null, errorCode: job.errorCode, manual: (job.scope as { reason?: string } | null)?.reason === "manual_sync" })),
  });
}
