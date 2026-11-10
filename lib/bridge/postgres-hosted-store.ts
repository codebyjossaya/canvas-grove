import "server-only";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { withTenantTransaction } from "@/lib/db";
import { canvasSessionHealthEvents, hostedBrowserProfiles, hostedBrowserSessions, interactiveSessionMonitors } from "@/lib/db/schema";
import type { HealthEventRow } from "@/lib/canvas/session-health";
import { normalizeAuthHostRules, toCanvasLoginPath } from "@/lib/canvas/institution";
import type { EncryptedBrowserState, HostedSession, HostedSessionState, HostedSessionStore } from "./hosted-browser";
import { BridgeError } from "./errors";

const PROVIDER = "hosted-browser";

function toDbState(state: HostedSessionState): typeof hostedBrowserSessions.$inferInsert.status {
  return ({ "awaiting-login": "auth_required", "auth-expired": "auth_required", terminated: "revoked" } as const)[state as "awaiting-login" | "auth-expired" | "terminated"] ?? state as "provisioning" | "active" | "failed";
}

type ProfileMetadata = { canvasOrigin: string; institutionName: string; authHostRules: string[]; loginPath: string };

function enrichProviderRef(value: string, metadata: ProfileMetadata): string {
  if (value.startsWith("pending:") || value.startsWith("revoked:")) return value;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.canvasOrigin !== metadata.canvasOrigin) return value;
    return Buffer.from(JSON.stringify({ ...parsed, authHostRules: metadata.authHostRules, loginPath: metadata.loginPath }), "utf8").toString("base64url");
  } catch { return value; }
}

function toDomain(row: typeof hostedBrowserSessions.$inferSelect & ProfileMetadata): HostedSession {
  const authHostRules = normalizeAuthHostRules(row.authHostRules, row.canvasOrigin);
  const metadata = { ...row, authHostRules };
  const state: HostedSessionState = row.status === "auth_required" ? "awaiting-login" : row.status === "revoked" ? "terminated" : row.status === "expired" ? "auth-expired" : row.status;
  return {
    id: row.id,
    userId: row.ownerId,
    canvasOrigin: row.canvasOrigin,
    institutionName: row.institutionName,
    authHostRules,
    loginPath: toCanvasLoginPath(row.loginPath),
    canvasAccountId: row.canvasExternalAccountId ?? undefined,
    providerSessionId: row.providerSessionRef.startsWith("pending:") ? undefined : enrichProviderRef(row.providerSessionRef, metadata),
    state,
    consentVersion: row.consentVersion,
    consentedAt: row.consentedAt.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastError: row.failureCode ?? undefined,
    interactiveAttemptId: row.interactiveAttemptId ?? undefined,
    interactiveAttemptStartedAt: row.interactiveAttemptStartedAt?.getTime(),
    interactiveAttemptDeadlineAt: row.interactiveAttemptDeadlineAt?.getTime(),
  };
}

export class PostgresHostedSessionStore implements HostedSessionStore {
  private async owner(clerkUserId: string) { return ensureUserForClerk(clerkUserId); }

  async create(session: HostedSession) {
    const ctx = await this.owner(session.userId);
    await withTenantTransaction(ctx.ownerId, async (tx) => {
      const [profile] = await tx.insert(hostedBrowserProfiles).values({
        ownerId: ctx.ownerId, provider: PROVIDER, providerProfileRef: session.id, canvasOrigin: session.canvasOrigin,
        institutionName: session.institutionName, authHostRules: session.authHostRules, loginPath: session.loginPath,
      }).returning({ id: hostedBrowserProfiles.id });
      await tx.insert(hostedBrowserSessions).values({
        id: session.id, ownerId: ctx.ownerId, profileId: profile.id, provider: PROVIDER,
        providerSessionRef: `pending:${session.id}`, providerSecretRef: `pending:${session.id}`,
        status: toDbState(session.state), consentVersion: session.consentVersion,
        consentedAt: new Date(session.consentedAt), createdAt: new Date(session.createdAt), updatedAt: new Date(session.updatedAt),
        interactiveAttemptId: session.interactiveAttemptId,
        interactiveAttemptStartedAt: session.interactiveAttemptStartedAt ? new Date(session.interactiveAttemptStartedAt) : null,
        interactiveAttemptDeadlineAt: session.interactiveAttemptDeadlineAt ? new Date(session.interactiveAttemptDeadlineAt) : null,
      });
    });
  }

  async getForOwner(id: string, clerkUserId: string) {
    const ctx = await this.owner(clerkUserId);
    return withTenantTransaction(ctx.ownerId, async (tx) => {
      const [row] = await tx.select({ session: hostedBrowserSessions, canvasOrigin: hostedBrowserProfiles.canvasOrigin, institutionName: hostedBrowserProfiles.institutionName, authHostRules: hostedBrowserProfiles.authHostRules, loginPath: hostedBrowserProfiles.loginPath })
        .from(hostedBrowserSessions).innerJoin(hostedBrowserProfiles, and(eq(hostedBrowserProfiles.ownerId, hostedBrowserSessions.ownerId), eq(hostedBrowserProfiles.id, hostedBrowserSessions.profileId)))
        .where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id))).limit(1);
      return row ? toDomain({ ...row.session, canvasOrigin: row.canvasOrigin, institutionName: row.institutionName, authHostRules: row.authHostRules, loginPath: row.loginPath }) : null;
    });
  }

  async listForOwner(clerkUserId: string) {
    const ctx = await this.owner(clerkUserId);
    return withTenantTransaction(ctx.ownerId, async (tx) => {
      const rows = await tx.select({ session: hostedBrowserSessions, canvasOrigin: hostedBrowserProfiles.canvasOrigin, institutionName: hostedBrowserProfiles.institutionName, authHostRules: hostedBrowserProfiles.authHostRules, loginPath: hostedBrowserProfiles.loginPath })
        .from(hostedBrowserSessions).innerJoin(hostedBrowserProfiles, and(eq(hostedBrowserProfiles.ownerId, hostedBrowserSessions.ownerId), eq(hostedBrowserProfiles.id, hostedBrowserSessions.profileId)))
        .where(eq(hostedBrowserSessions.ownerId, ctx.ownerId)).orderBy(desc(hostedBrowserSessions.createdAt));
      return rows.map((row) => toDomain({ ...row.session, canvasOrigin: row.canvasOrigin, institutionName: row.institutionName, authHostRules: row.authHostRules, loginPath: row.loginPath }));
    });
  }

  async updateForOwner(id: string, clerkUserId: string, patch: Partial<HostedSession>) {
    const ctx = await this.owner(clerkUserId);
    await withTenantTransaction(ctx.ownerId, async (tx) => {
      const values: Partial<typeof hostedBrowserSessions.$inferInsert> = { updatedAt: new Date() };
      if (patch.state) {
        values.status = toDbState(patch.state);
        if (patch.state === "terminated") values.revokedAt = new Date();
      }
      if (patch.providerSessionId !== undefined) {
        values.providerSessionRef = patch.providerSessionId || `pending:${id}`;
        values.providerSecretRef = patch.providerSessionId || `pending:${id}`;
      }
      if (patch.canvasAccountId !== undefined) values.canvasExternalAccountId = patch.canvasAccountId;
      if (patch.lastError !== undefined) values.failureCode = patch.lastError;
      await tx.update(hostedBrowserSessions).set(values).where(and(
        eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id),
        patch.interactiveAttemptId ? eq(hostedBrowserSessions.interactiveAttemptId, patch.interactiveAttemptId) : undefined,
        patch.state === "terminated" ? undefined : ne(hostedBrowserSessions.status, "revoked"),
      ));
    });
    return this.getForOwner(id, clerkUserId);
  }

  async revokeForOwner(id: string, clerkUserId: string) {
    const ctx = await this.owner(clerkUserId);
    await withTenantTransaction(ctx.ownerId, async (tx) => {
      const revokedRef = `revoked:${id}:${Date.now()}`;
      await tx.update(interactiveSessionMonitors).set({
        status: "cancelled", finishedAt: new Date(), leaseOwner: null, leaseTokenHash: null,
        leaseExpiresAt: null, lastErrorCode: "USER_REVOKED", updatedAt: new Date(),
      }).where(and(eq(interactiveSessionMonitors.ownerId, ctx.ownerId), eq(interactiveSessionMonitors.hostedSessionId, id)));
      await tx.update(hostedBrowserSessions).set({
        status: "revoked", revokedAt: new Date(), providerSessionRef: revokedRef,
        providerSecretRef: revokedRef, failureCode: null, updatedAt: new Date(),
      }).where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id)));
    });
    return this.getForOwner(id, clerkUserId);
  }

  async saveEncryptedState(id: string, clerkUserId: string, state: EncryptedBrowserState) {
    const ctx = await this.owner(clerkUserId);
    await withTenantTransaction(ctx.ownerId, async (tx) => {
      const updated = await tx.update(hostedBrowserSessions).set({
        encryptedStateCiphertext: JSON.stringify({ ciphertext: state.ciphertext, authTag: state.authTag, algorithm: state.algorithm }),
        encryptedStateNonce: state.iv,
        wrappedDataKey: state.wrappedDataKey,
        keyVersion: Number.parseInt(state.keyId, 10) || 1,
        providerSecretRef: null,
        updatedAt: new Date(),
      }).where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id))).returning({ id: hostedBrowserSessions.id });
      if (!updated.length) throw new Error("Hosted session not found");
    });
  }

  async loadEncryptedState(id: string, clerkUserId: string) {
    const ctx = await this.owner(clerkUserId);
    return withTenantTransaction(ctx.ownerId, async (tx) => {
      const [row] = await tx.select({
        ciphertext: hostedBrowserSessions.encryptedStateCiphertext,
        iv: hostedBrowserSessions.encryptedStateNonce,
        wrappedDataKey: hostedBrowserSessions.wrappedDataKey,
        keyVersion: hostedBrowserSessions.keyVersion,
      }).from(hostedBrowserSessions).where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id))).limit(1);
      if (!row?.ciphertext || !row.iv || !row.wrappedDataKey || row.keyVersion == null) return null;
      const payload = JSON.parse(row.ciphertext) as { ciphertext?: unknown; authTag?: unknown; algorithm?: unknown };
      if (typeof payload.ciphertext !== "string" || typeof payload.authTag !== "string" || payload.algorithm !== "AES-256-GCM") return null;
      return { ciphertext: payload.ciphertext, authTag: payload.authTag, algorithm: "AES-256-GCM" as const, iv: row.iv, wrappedDataKey: row.wrappedDataKey, keyId: String(row.keyVersion) };
    });
  }

  async compareAndSwapEncryptedState(id: string, clerkUserId: string, expectedIv: string, state: EncryptedBrowserState) {
    const ctx = await this.owner(clerkUserId);
    return withTenantTransaction(ctx.ownerId, async (tx) => {
      const updated = await tx.update(hostedBrowserSessions).set({
        encryptedStateCiphertext: JSON.stringify({ ciphertext: state.ciphertext, authTag: state.authTag, algorithm: state.algorithm }),
        encryptedStateNonce: state.iv, wrappedDataKey: state.wrappedDataKey, keyVersion: Number.parseInt(state.keyId, 10) || 1, updatedAt: new Date(),
      }).where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id), eq(hostedBrowserSessions.encryptedStateNonce, expectedIv), isNull(hostedBrowserSessions.revokedAt)))
        .returning({ id: hostedBrowserSessions.id });
      return updated.length === 1;
    });
  }

  async recordHealthEvent(id: string, clerkUserId: string, row: HealthEventRow) {
    const ctx = await this.owner(clerkUserId);
    await withTenantTransaction(ctx.ownerId, async (tx) => {
      // Names and booleans only (see HEALTH_EVENT_COLUMNS); never cookie values.
      await tx.insert(canvasSessionHealthEvents).values({
        ownerId: ctx.ownerId, hostedSessionId: id, at: row.at, kind: row.kind, httpStatus: row.http_status, outcome: row.outcome,
        rotated: row.rotated, cookieNamesRotated: row.cookie_names_rotated, sessionCookieReissued: row.session_cookie_reissued,
        rememberCookiePresent: row.remember_cookie_present, rememberCookieUsed: row.remember_cookie_used, callCount: row.call_count,
        okCount: row.ok_count, authRequiredCount: row.auth_required_count, errorCount: row.error_count, sessionCookieReissueCount: row.session_cookie_reissue_count,
      });
    });
  }

  async compareAndSwapProviderForOwner(id: string, clerkUserId: string, expectedProviderSessionId: string, nextProviderSessionId: string) {
    const ctx = await this.owner(clerkUserId);
    return withTenantTransaction(ctx.ownerId, async (tx) => {
      const updated = await tx.update(hostedBrowserSessions).set({
        providerSessionRef: nextProviderSessionId, providerSecretRef: null, failureCode: null, updatedAt: new Date(),
      }).where(and(
        eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id),
        eq(hostedBrowserSessions.providerSessionRef, expectedProviderSessionId), eq(hostedBrowserSessions.status, "active"),
      )).returning({ id: hostedBrowserSessions.id });
      return updated.length === 1;
    });
  }

  async startNewInteractiveAttempt(id: string, clerkUserId: string) {
    const ctx = await this.owner(clerkUserId);
    await withTenantTransaction(ctx.ownerId, async (tx) => {
      // A repeated click observes the already-created pending attempt. Only a
      // terminal timeout whose cleanup has completed may rotate the identity.
      const [current] = await tx.select().from(hostedBrowserSessions).where(and(
        eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id),
      )).limit(1);
      if (!current) return;
      if (
        ["provisioning", "auth_required"].includes(current.status)
        && current.interactiveAttemptId
        && current.interactiveAttemptDeadlineAt
        && current.interactiveAttemptDeadlineAt.getTime() > Date.now()
      ) return;
      const legacyMissingRuntime = current.status === "auth_required" && current.failureCode === "BROWSER_SESSION_NOT_FOUND" && !current.interactiveAttemptId;
      if ((current.status !== "expired" || current.failureCode !== "INTERACTIVE_AUTH_TIMEOUT") && !legacyMissingRuntime) {
        throw new BridgeError("INVALID_SESSION_STATE", "Only an expired sign-in can be restarted.", 409);
      }
      const now = new Date();
      const attemptId = crypto.randomUUID();
      await tx.update(hostedBrowserSessions).set({
        status: "provisioning", providerSessionRef: `pending:${attemptId}`, providerSecretRef: `pending:${attemptId}`,
        failureCode: null, revokedAt: null, interactiveAttemptId: attemptId,
        interactiveAttemptStartedAt: now, interactiveAttemptDeadlineAt: new Date(now.getTime() + 30 * 60_000), updatedAt: now,
      }).where(and(eq(hostedBrowserSessions.ownerId, ctx.ownerId), eq(hostedBrowserSessions.id, id),
        legacyMissingRuntime ? eq(hostedBrowserSessions.failureCode, "BROWSER_SESSION_NOT_FOUND") : eq(hostedBrowserSessions.status, "expired")));
    });
    return this.getForOwner(id, clerkUserId);
  }
}
