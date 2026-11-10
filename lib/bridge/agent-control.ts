import "server-only";
import { digest, newId, newSecret, safeHashEqual } from "./crypto";

export type ControlLease = { id: string; sessionId: string; ownerId: string; tokenHash: string; expiresAt: number; revokedAt?: number };

class AgentControlStore {
  private leases = new Map<string, ControlLease>();

  acquire(sessionId: string, ownerId: string) {
    const now = Date.now();
    const existing = [...this.leases.values()].find((item) => item.sessionId === sessionId && !item.revokedAt && item.expiresAt > now);
    if (existing) throw new Error("This browser already has an active controller");
    const token = newSecret();
    const lease: ControlLease = { id: newId(), sessionId, ownerId, tokenHash: digest(token), expiresAt: now + 2 * 60_000 };
    this.leases.set(lease.id, lease);
    return { lease, token };
  }

  authenticate(sessionId: string, authorization: string | null) {
    const match = /^AgentLease ([0-9a-f-]+)\.([A-Za-z0-9_-]{20,})$/.exec(authorization || "");
    if (!match) return null;
    const lease = this.leases.get(match[1]);
    if (!lease || lease.sessionId !== sessionId || lease.revokedAt || lease.expiresAt <= Date.now() || !safeHashEqual(lease.tokenHash, digest(match[2]))) return null;
    return lease;
  }

  revokeForOwner(sessionId: string, ownerId: string) {
    for (const lease of this.leases.values()) if (lease.sessionId === sessionId && lease.ownerId === ownerId && !lease.revokedAt) lease.revokedAt = Date.now();
  }
}

type AuditEvent = { ownerId: string; sessionId: string; action: string; outcome: "allowed" | "denied"; at: number };
export interface AgentControlAuditSink { record(event: AuditEvent): Promise<void>; }
class NoopAuditSink implements AgentControlAuditSink { async record() {} }

const globals = globalThis as typeof globalThis & { __agentControlStore?: AgentControlStore; __agentControlAudit?: AgentControlAuditSink };
export const agentControlStore = globals.__agentControlStore ??= new AgentControlStore();
export const agentControlAudit = globals.__agentControlAudit ??= new NoopAuditSink();
