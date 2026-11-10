import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { ensureUserForClerk } from "./auth-context";
import { withTenantTransaction } from "./index";
import { auditEvents, hostedBrowserSessions, remoteBrowserControlLeases } from "./schema";

export async function createControlLease(input: {
  clerkUserId: string; sessionId: string; controllerType: string; controllerId: string;
  leaseTokenHash: string; takeoverTokenRef?: string; expiresAt: Date;
}) {
  const ctx = await ensureUserForClerk(input.clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [session] = await tx.select({ id: hostedBrowserSessions.id }).from(hostedBrowserSessions).where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, input.sessionId))).limit(1);
    if (!session) throw new Error("Hosted session not found");
    await tx.update(remoteBrowserControlLeases).set({ status: "revoked", revokedAt: new Date(), revokeReason: "superseded", updatedAt: new Date() }).where(and(eq(remoteBrowserControlLeases.ownerId, ctx.ownerId), eq(remoteBrowserControlLeases.sessionId, input.sessionId), eq(remoteBrowserControlLeases.status, "active")));
    const [lease] = await tx.insert(remoteBrowserControlLeases).values({ ownerId: ctx.ownerId, sessionId: input.sessionId, controllerType: input.controllerType, controllerId: input.controllerId, leaseTokenHash: input.leaseTokenHash, takeoverTokenRef: input.takeoverTokenRef, leaseExpiresAt: input.expiresAt }).returning();
    await tx.insert(auditEvents).values({ ownerId: ctx.ownerId, actorClerkUserId: input.clerkUserId, actorType: "user", action: "browser.auth_handoff.created", targetType: "control_lease", targetId: lease.id, outcome: "pending", metadataRedacted: { sessionId: input.sessionId, controllerType: input.controllerType } });
    return lease;
  });
}

export async function activateControlLease(clerkUserId: string, leaseId: string, leaseTokenHash: string) {
  const ctx = await ensureUserForClerk(clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [lease] = await tx.update(remoteBrowserControlLeases).set({ status: "active", activatedAt: new Date(), takeoverTokenRef: null, updatedAt: new Date() }).where(and(eq(remoteBrowserControlLeases.ownerId, ctx.ownerId), eq(remoteBrowserControlLeases.id, leaseId), eq(remoteBrowserControlLeases.leaseTokenHash, leaseTokenHash), eq(remoteBrowserControlLeases.status, "pending"), gt(remoteBrowserControlLeases.leaseExpiresAt, new Date()))).returning();
    if (!lease) throw new Error("Control lease not found or already consumed");
    await tx.insert(auditEvents).values({ ownerId: ctx.ownerId, actorClerkUserId: clerkUserId, actorType: "user", action: "browser.auth_handoff.activated", targetType: "control_lease", targetId: leaseId, outcome: "active", metadataRedacted: { sessionId: lease.sessionId } });
    return lease;
  });
}

export async function revokeControlLease(clerkUserId: string, leaseId: string, reason = "user_revoked") {
  const ctx = await ensureUserForClerk(clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [lease] = await tx.update(remoteBrowserControlLeases).set({ status: "revoked", revokedAt: new Date(), takeoverTokenRef: null, revokeReason: reason, updatedAt: new Date() }).where(and(eq(remoteBrowserControlLeases.ownerId, ctx.ownerId), eq(remoteBrowserControlLeases.id, leaseId))).returning();
    if (!lease) return null;
    await tx.insert(auditEvents).values({ ownerId: ctx.ownerId, actorClerkUserId: clerkUserId, actorType: "user", action: "browser.auth_handoff.revoked", targetType: "control_lease", targetId: leaseId, outcome: "revoked", metadataRedacted: { sessionId: lease.sessionId, reason } });
    return lease;
  });
}
