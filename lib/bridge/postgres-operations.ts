import "server-only";
import { and, eq } from "drizzle-orm";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { withTenantTransaction } from "@/lib/db";
import { auditEvents, canvasOperations, idempotencyKeys, operationPreviews } from "@/lib/db/schema";
import { canonicalJson, digest, newId } from "./crypto";
import type { CanvasRequest, Preview } from "./types";

export async function persistPreview(preview: Preview): Promise<void> {
  const ctx = await ensureUserForClerk(preview.userId);
  await withTenantTransaction(ctx.ownerId, (tx) => tx.insert(operationPreviews).values({
    id: preview.id, ownerId: ctx.ownerId, action: preview.operation, requestDigest: preview.digest,
    preview: { parameters: preview.parameters, request: preview.request, risk: preview.risk },
    createdAt: new Date(preview.createdAt), expiresAt: new Date(preview.expiresAt),
  }).onConflictDoNothing());
}

export async function readPreview(id: string, clerkUserId: string): Promise<Preview | null> {
  const ctx = await ensureUserForClerk(clerkUserId);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [row] = await tx.select().from(operationPreviews).where(and(eq(operationPreviews.ownerId, ctx.ownerId), eq(operationPreviews.id, id))).limit(1);
    if (!row) return null;
    const value = row.preview as { parameters: Record<string, unknown>; request: CanvasRequest; risk: Preview["risk"] };
    return { id: row.id, userId: clerkUserId, operation: row.action, parameters: value.parameters, request: value.request, digest: row.requestDigest, risk: value.risk, createdAt: row.createdAt.getTime(), expiresAt: row.expiresAt.getTime(), usedAt: row.confirmedAt?.getTime() };
  });
}

export type StoredExecution = { replay: boolean; ok: boolean; status: number; authRequired: boolean; data?: unknown; error?: string };

export async function beginHostedOperation(clerkUserId: string, key: string, request: CanvasRequest): Promise<{ operationId: string } | { prior: StoredExecution }> {
  const ctx = await ensureUserForClerk(clerkUserId);
  const requestHash = digest(canonicalJson(request));
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const [existing] = await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.ownerId, ctx.ownerId), eq(idempotencyKeys.key, key))).limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("Idempotency key was already used for a different request");
      if (existing.responseBodyRedacted) return { prior: { ...(existing.responseBodyRedacted as Omit<StoredExecution, "replay">), replay: true } };
      throw new Error("An operation with this idempotency key is already in progress");
    }
    const operationId = newId();
    await tx.insert(canvasOperations).values({ id: operationId, ownerId: ctx.ownerId, action: "hosted.execute", method: request.method, canvasPath: request.path, requestRedacted: { hasBody: Boolean(request.body) }, status: "dispatched", idempotencyKey: key, dispatchedAt: new Date() });
    await tx.insert(idempotencyKeys).values({ ownerId: ctx.ownerId, key, requestHash, operationId, lockedUntil: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000) });
    await tx.insert(auditEvents).values({ ownerId: ctx.ownerId, actorClerkUserId: clerkUserId, actorType: "user", action: "canvas.operation.dispatched", targetType: "canvas_operation", targetId: operationId, outcome: "accepted", metadataRedacted: { method: request.method, path: request.path } });
    return { operationId };
  });
}

export async function finishHostedOperation(clerkUserId: string, key: string, operationId: string, result: Omit<StoredExecution, "replay">): Promise<void> {
  const ctx = await ensureUserForClerk(clerkUserId);
  await withTenantTransaction(ctx.ownerId, async (tx) => {
    const state = result.ok ? "succeeded" : result.authRequired ? "unknown" : "failed";
    await tx.update(canvasOperations).set({ status: state, responseStatus: result.status, responseRedacted: result, completedAt: new Date(), updatedAt: new Date(), errorCode: result.error }).where(and(eq(canvasOperations.ownerId, ctx.ownerId), eq(canvasOperations.id, operationId)));
    await tx.update(idempotencyKeys).set({ state: "completed", responseStatus: result.status, responseBodyRedacted: result, lockedUntil: null }).where(and(eq(idempotencyKeys.ownerId, ctx.ownerId), eq(idempotencyKeys.key, key)));
    await tx.insert(auditEvents).values({ ownerId: ctx.ownerId, actorClerkUserId: clerkUserId, actorType: "user", action: "canvas.operation.completed", targetType: "canvas_operation", targetId: operationId, outcome: state, metadataRedacted: { status: result.status, authRequired: result.authRequired } });
  });
}
