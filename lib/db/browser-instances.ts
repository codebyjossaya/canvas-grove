import "server-only";
import { and, eq } from "drizzle-orm";
import { ensureUserForClerk } from "./auth-context";
import { withTenantTransaction } from "./index";
import { hostedBrowserSessions, selfHostedBrowserInstances } from "./schema";

export async function upsertBrowserInstance(input: {
  clerkUserId: string; sessionId: string; runtimeId: string; containerRef: string;
  profileVolumeRef?: string; cdpEndpointRef?: string; resourceLimits?: Record<string, unknown>;
}) {
  const ctx = await ensureUserForClerk(input.clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [session] = await tx.select({ id: hostedBrowserSessions.id }).from(hostedBrowserSessions)
      .where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, input.sessionId))).limit(1);
    if (!session) throw new Error("Hosted session not found");
    const [instance] = await tx.insert(selfHostedBrowserInstances).values({
      ownerId: ctx.ownerId, sessionId: input.sessionId, runtimeId: input.runtimeId,
      containerRef: input.containerRef, profileVolumeRef: input.profileVolumeRef,
      cdpEndpointRef: input.cdpEndpointRef, resourceLimits: input.resourceLimits ?? {},
    }).onConflictDoUpdate({ target: [selfHostedBrowserInstances.ownerId, selfHostedBrowserInstances.sessionId], set: {
      runtimeId: input.runtimeId, containerRef: input.containerRef, profileVolumeRef: input.profileVolumeRef,
      cdpEndpointRef: input.cdpEndpointRef, resourceLimits: input.resourceLimits ?? {}, updatedAt: new Date(),
    } }).returning();
    return instance;
  });
}

export async function updateBrowserInstanceState(clerkUserId: string, sessionId: string, state: {
  status: "provisioning" | "running" | "stopped" | "failed" | "revoked"; failureCode?: string;
}) {
  const ctx = await ensureUserForClerk(clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const now = new Date();
    const [instance] = await tx.update(selfHostedBrowserInstances).set({
      status: state.status, failureCode: state.failureCode, lastHeartbeatAt: state.status === "running" ? now : undefined,
      stoppedAt: state.status === "stopped" ? now : undefined, revokedAt: state.status === "revoked" ? now : undefined, updatedAt: now,
    }).where(and(eq(selfHostedBrowserInstances.ownerId, ctx.ownerId), eq(selfHostedBrowserInstances.sessionId, sessionId))).returning();
    return instance ?? null;
  });
}

export async function getBrowserInstance(clerkUserId: string, sessionId: string) {
  const ctx = await ensureUserForClerk(clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [instance] = await tx.select().from(selfHostedBrowserInstances)
      .where(and(eq(selfHostedBrowserInstances.ownerId, ctx.ownerId), eq(selfHostedBrowserInstances.sessionId, sessionId))).limit(1);
    return instance ?? null;
  });
}
