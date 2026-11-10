import { newId } from "./crypto";
import type { CanvasRequest } from "./types";
import { PostgresHostedSessionStore } from "./postgres-hosted-store";
import { beginHostedOperation, finishHostedOperation } from "./postgres-operations";
import { createHostedBrowserProvider } from "./providers";
import { BridgeError } from "./errors";
import type { CanvasLoginPath } from "@/lib/canvas/institution";
import type { DisplaySize } from "./display";
import { CanvasSessionClient, type CanvasApiResult } from "@/lib/canvas/session-client";
import { healthEventRow, type HealthEventRow } from "@/lib/canvas/session-health";

export type HostedSessionState = "provisioning" | "awaiting-login" | "active" | "auth-expired" | "terminated" | "failed";

export type HostedSession = {
  id: string;
  userId: string;
  canvasOrigin: string;
  institutionName: string;
  authHostRules: string[];
  loginPath: CanvasLoginPath;
  canvasAccountId?: string;
  providerSessionId?: string;
  state: HostedSessionState;
  consentVersion: string;
  consentedAt: number;
  createdAt: number;
  updatedAt: number;
  liveViewExpiresAt?: number;
  lastError?: string;
  interactiveAttemptId?: string;
  interactiveAttemptStartedAt?: number;
  interactiveAttemptDeadlineAt?: number;
};

/** Opaque ciphertext only. Implementations must never return decrypted browser state to routes. `iv` is unique per encryption and doubles as the compare-and-swap version. */
export type EncryptedBrowserState = {
  ciphertext: string;
  wrappedDataKey: string;
  keyId: string;
  algorithm: "AES-256-GCM";
  iv: string;
  authTag: string;
};

/**
 * The hosted browser is used ONLY for interactive sign-in. It has no request
 * execution method: every Canvas API call goes through the server-side
 * cookie client (lib/canvas/session-client.ts).
 */
export interface HostedBrowserProvider {
  provision(input: { ownerId: string; canvasOrigin: string; authHostRules: string[]; loginPath: CanvasLoginPath; display?: DisplaySize; encryptedState?: EncryptedBrowserState }): Promise<{ providerSessionId: string }>;
  interactiveConnect(providerSessionId: string): Promise<{ url: string; expiresAt: number }>;
  status(providerSessionId: string): Promise<{ state: Exclude<HostedSessionState, "terminated">; canvasAccountId?: string; authRequired?: boolean }>;
  navigate(providerSessionId: string, destination: "canvas-home" | "canvas-login"): Promise<void>;
  relinquishInteractive(providerSessionId: string): Promise<{ providerSessionId: string }>;
  snapshotEncrypted(providerSessionId: string, ownerId: string): Promise<EncryptedBrowserState>;
  terminate(providerSessionId: string): Promise<void>;
}

export interface HostedSessionStore {
  create(session: HostedSession): Promise<void>;
  getForOwner(id: string, ownerId: string): Promise<HostedSession | null>;
  listForOwner(ownerId: string): Promise<HostedSession[]>;
  updateForOwner(id: string, ownerId: string, patch: Partial<HostedSession>): Promise<HostedSession | null>;
  revokeForOwner(id: string, ownerId: string): Promise<HostedSession | null>;
  saveEncryptedState(id: string, ownerId: string, state: EncryptedBrowserState): Promise<void>;
  loadEncryptedState(id: string, ownerId: string): Promise<EncryptedBrowserState | null>;
  /** Persist a rotated cookie jar only if the stored state's IV is still `expectedIv`. */
  compareAndSwapEncryptedState(id: string, ownerId: string, expectedIv: string, next: EncryptedBrowserState): Promise<boolean>;
  recordHealthEvent(id: string, ownerId: string, row: HealthEventRow): Promise<void>;
  compareAndSwapProviderForOwner(id: string, ownerId: string, expectedProviderSessionId: string, nextProviderSessionId: string): Promise<boolean>;
  startNewInteractiveAttempt(id: string, ownerId: string): Promise<HostedSession | null>;
}

class MemoryHostedSessionStore implements HostedSessionStore {
  private sessions = new Map<string, HostedSession>();
  // Development-only ciphertext storage. No method exposes it to an HTTP route.
  private encryptedStates = new Map<string, EncryptedBrowserState>();
  async create(session: HostedSession) { this.sessions.set(session.id, session); }
  async getForOwner(id: string, ownerId: string) { const item = this.sessions.get(id); return item?.userId === ownerId ? item : null; }
  async listForOwner(ownerId: string) { return [...this.sessions.values()].filter((item) => item.userId === ownerId); }
  async updateForOwner(id: string, ownerId: string, patch: Partial<HostedSession>) {
    const item = await this.getForOwner(id, ownerId);
    if (!item || item.state === "terminated" && patch.state !== "terminated") return item;
    const updated = { ...item, ...patch, id: item.id, userId: item.userId, updatedAt: Date.now() };
    this.sessions.set(id, updated);
    return updated;
  }
  async revokeForOwner(id: string, ownerId: string) {
    return this.updateForOwner(id, ownerId, { state: "terminated", providerSessionId: undefined, liveViewExpiresAt: undefined });
  }
  async saveEncryptedState(id: string, ownerId: string, state: EncryptedBrowserState) {
    if (!await this.getForOwner(id, ownerId)) throw new Error("Hosted session not found");
    this.encryptedStates.set(id, state);
  }
  async loadEncryptedState(id: string, ownerId: string) {
    if (!await this.getForOwner(id, ownerId)) return null;
    return this.encryptedStates.get(id) ?? null;
  }
  async compareAndSwapEncryptedState(id: string, ownerId: string, expectedIv: string, next: EncryptedBrowserState) {
    if (!await this.getForOwner(id, ownerId) || this.encryptedStates.get(id)?.iv !== expectedIv) return false;
    this.encryptedStates.set(id, next);
    return true;
  }
  async recordHealthEvent() { /* development store keeps no health log */ }
  async compareAndSwapProviderForOwner(id: string, ownerId: string, expectedProviderSessionId: string, nextProviderSessionId: string) {
    const session = await this.getForOwner(id, ownerId);
    if (!session || session.providerSessionId !== expectedProviderSessionId || session.state === "terminated") return false;
    await this.updateForOwner(id, ownerId, { providerSessionId: nextProviderSessionId, lastError: undefined });
    return true;
  }
  async startNewInteractiveAttempt(id: string, ownerId: string) {
    const session = await this.getForOwner(id, ownerId);
    if (!session) return null;
    if (["provisioning", "awaiting-login"].includes(session.state) && (session.interactiveAttemptDeadlineAt ?? 0) > Date.now()) return session;
    const legacyMissingRuntime = session.state === "awaiting-login" && session.lastError === "BROWSER_SESSION_NOT_FOUND" && !session.interactiveAttemptId;
    if (session.state !== "auth-expired" && !legacyMissingRuntime) throw new BridgeError("INVALID_SESSION_STATE", "Only an expired sign-in can be restarted.", 409);
    const now = Date.now();
    return this.updateForOwner(id, ownerId, { state: "provisioning", providerSessionId: undefined, lastError: undefined, interactiveAttemptId: newId(), interactiveAttemptStartedAt: now, interactiveAttemptDeadlineAt: now + INTERACTIVE_SIGN_IN_TTL_MS });
  }
}

const globals = globalThis as typeof globalThis & {
  __hostedSessionStore?: HostedSessionStore;
  __hostedBrowserProvider?: HostedBrowserProvider;
  __hostedExecutionResults?: Map<string, HostedExecutionResult>;
};

function createHostedSessionStore(): HostedSessionStore {
  return process.env.DATABASE_URL ? new PostgresHostedSessionStore() : new MemoryHostedSessionStore();
}

export const hostedSessionStore = globals.__hostedSessionStore ??= createHostedSessionStore();
export const hostedBrowserProvider = globals.__hostedBrowserProvider ??= createHostedBrowserProvider();
export const HOSTED_BROWSER_CONSENT_VERSION = "2026-11-07.v1";
export const INTERACTIVE_SIGN_IN_TTL_MS = 30 * 60 * 1000;

export type HostedExecutionResult = { replay: boolean; ok: boolean; status: number; authRequired: boolean; data?: unknown; error?: string };

const executionResults = globals.__hostedExecutionResults ??= new Map<string, HostedExecutionResult>();

/** Server-side Canvas API client for an active session's captured cookie jar. `ownerId` is the caller's store identity (Clerk id). */
export function canvasApiForSession(session: HostedSession, ownerId: string): CanvasSessionClient {
  return new CanvasSessionClient({
    ownerId: session.userId, canvasOrigin: session.canvasOrigin,
    store: {
      load: async () => { const state = await hostedSessionStore.loadEncryptedState(session.id, ownerId); return state ? { state, version: state.iv } : null; },
      compareAndSwap: (next, expectedVersion) => hostedSessionStore.compareAndSwapEncryptedState(session.id, ownerId, expectedVersion, next),
    },
  });
}

/**
 * One app-initiated Canvas call over the direct API (no browser). Rotated
 * cookies are persisted before returning, a value-free health row is
 * recorded, and a Canvas auth rejection marks the session expired.
 */
export async function executeCanvasApiForSession(session: HostedSession, ownerId: string, request: CanvasRequest): Promise<CanvasApiResult> {
  if (session.state !== "active") throw new BridgeError("CANVAS_SESSION_EXPIRED", "Sign in to Canvas again.", 401);
  const client = canvasApiForSession(session, ownerId);
  try {
    const result = await client.request(request);
    if (result.authRequired) await hostedSessionStore.updateForOwner(session.id, ownerId, { state: "auth-expired", lastError: "CANVAS_SESSION_EXPIRED" });
    return result;
  } finally {
    await client.flush().catch(() => undefined);
    const row = healthEventRow(client.stats(), { ownerId: session.userId, hostedSessionId: session.id, kind: "api" });
    if (row) await hostedSessionStore.recordHealthEvent(session.id, ownerId, row).catch(() => undefined);
  }
}

export async function executeInHostedSession(input: {
  ownerId: string;
  sessionId: string;
  idempotencyKey: string;
  request: CanvasRequest;
}): Promise<HostedExecutionResult> {
  const resultKey = `${input.ownerId}:${input.idempotencyKey}`;
  const session = await hostedSessionStore.getForOwner(input.sessionId, input.ownerId);
  if (!session) throw new Error("Hosted session not found");
  if (session.state !== "active") throw new Error(session.state === "auth-expired" ? "Canvas authentication has expired" : "Hosted session is not active");
  const persistent = process.env.DATABASE_URL ? await beginHostedOperation(input.ownerId, input.idempotencyKey, input.request) : null;
  if (persistent && "prior" in persistent) return persistent.prior;
  const prior = persistent ? undefined : executionResults.get(resultKey);
  if (prior) return { ...prior, replay: true };
  // Direct API call; cookie rotations are persisted by the client itself.
  const response = await executeCanvasApiForSession(session, input.ownerId, input.request);
  const executed = { ok: response.ok, status: response.status, authRequired: response.authRequired, data: response.data };
  const result = { ...executed, replay: false };
  if (persistent && "operationId" in persistent) await finishHostedOperation(input.ownerId, input.idempotencyKey, persistent.operationId, executed);
  else executionResults.set(resultKey, result);
  return result;
}

export function newHostedSession(userId: string, canvasOrigin: string, institutionName: string, authHostRules: string[], loginPath: CanvasLoginPath): HostedSession {
  const now = Date.now();
  return { id: newId(), userId, canvasOrigin, institutionName, authHostRules, loginPath, state: "provisioning", consentVersion: HOSTED_BROWSER_CONSENT_VERSION, consentedAt: now, createdAt: now, updatedAt: now, interactiveAttemptId: newId(), interactiveAttemptStartedAt: now, interactiveAttemptDeadlineAt: now + INTERACTIVE_SIGN_IN_TTL_MS };
}

export function publicHostedSession(session: HostedSession) {
  return {
    id: session.id,
    canvasOrigin: session.canvasOrigin,
    institutionName: session.institutionName,
    canvasAccountId: session.canvasAccountId,
    state: session.state,
    consentVersion: session.consentVersion,
    createdAt: new Date(session.createdAt).toISOString(),
    interactiveAuthExpiresAt: ["provisioning", "awaiting-login"].includes(session.state) && session.interactiveAttemptDeadlineAt
      ? new Date(session.interactiveAttemptDeadlineAt).toISOString()
      : null,
    updatedAt: new Date(session.updatedAt).toISOString(),
    lastError: session.lastError,
  };
}
