import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { canvasAccounts, hostedBrowserSessions, syncJobs, syncPolicies, userPreferences } from "@/lib/db/schema";
import { isSyncKindAllowed } from "@/lib/scopes/catalog";
import { storedDataScopes } from "@/lib/scopes/settings";
import type { SyncKind } from "./catalog";

export async function enqueueManualSync(ctx: AuthContext) {
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [account] = await tx.select({ id: canvasAccounts.id }).from(canvasAccounts)
      .where(and(eq(canvasAccounts.ownerId, ctx.ownerId), eq(canvasAccounts.status, "connected"))).limit(1);
    if (!account) return { state: "not-connected" as const, jobIds: [], queued: 0, deduped: 0 };
    const [session] = await tx.select({ id: hostedBrowserSessions.id }).from(hostedBrowserSessions)
      .where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.canvasAccountId, account.id), eq(hostedBrowserSessions.status, "active")))
      .orderBy(desc(hostedBrowserSessions.updatedAt)).limit(1);
    if (!session) return { state: "auth-required" as const, jobIds: [], queued: 0, deduped: 0 };
    const allPolicies = await tx.select({ id: syncPolicies.id, kind: syncPolicies.resourceType, priority: syncPolicies.priority })
      .from(syncPolicies).where(and(eq(syncPolicies.ownerId, ctx.ownerId), eq(syncPolicies.canvasAccountId, account.id), eq(syncPolicies.status, "active")));
    if (!allPolicies.length) return { state: "not-initialized" as const, jobIds: [], queued: 0, deduped: 0 };
    // Skip data areas the user turned off (Settings > Data & permissions).
    const [pref] = await tx.select({ dataScopes: userPreferences.dataScopes }).from(userPreferences).where(eq(userPreferences.ownerId, ctx.ownerId)).limit(1);
    const enabled = storedDataScopes(pref?.dataScopes ?? null);
    const policies = allPolicies.filter((policy) => isSyncKindAllowed(policy.kind as SyncKind, enabled));
    const inserted: string[] = [];
    for (const policy of policies) {
      const rows = await tx.insert(syncJobs).values({ ownerId: ctx.ownerId, canvasAccountId: account.id, hostedSessionId: session.id,
        policyId: policy.id, kind: policy.kind, scope: { reason: "manual_sync" }, dedupeKey: `${account.id}:${policy.kind}`,
        priority: Math.max(250, policy.priority), runAfter: new Date() }).onConflictDoNothing().returning({ id: syncJobs.id });
      if (rows[0]) inserted.push(rows[0].id);
    }
    const active = await tx.select({ id: syncJobs.id }).from(syncJobs).where(and(eq(syncJobs.ownerId, ctx.ownerId),
      eq(syncJobs.canvasAccountId, account.id), inArray(syncJobs.status, ["queued", "leased", "running"])));
    return { state: "queued" as const, jobIds: active.map((job) => job.id), queued: inserted.length, deduped: policies.length - inserted.length };
  });
}
