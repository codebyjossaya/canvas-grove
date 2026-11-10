import "server-only";
import { digest, newSecret } from "./crypto";
import type { BridgeStore, Device, Job, Pairing, Preview } from "./types";
import { persistPreview, readPreview } from "./postgres-operations";

export class MemoryBridgeStore implements BridgeStore {
  pairings = new Map<string, Pairing>();
  devices = new Map<string, Device>();
  previews = new Map<string, Preview>();
  jobs = new Map<string, Job>();
  idempotency = new Map<string, string>();

  async createPairing(value: Pairing) { this.pairings.set(value.id, value); }
  async claimPairing(codeHash: string, now: number) {
    const pairing = [...this.pairings.values()].find((p) => p.codeHash === codeHash && !p.usedAt && p.expiresAt > now && p.attempts < 5);
    if (!pairing) return null;
    pairing.usedAt = now;
    return pairing;
  }
  async createDevice(value: Device) { this.devices.set(value.id, value); }
  async getDevice(id: string) { return this.devices.get(id) ?? null; }
  async touchDevice(id: string, at: number) { const value = this.devices.get(id); if (value) value.lastSeenAt = at; }
  async createPreview(value: Preview) { this.previews.set(value.id, value); }
  async getPreview(id: string) { return this.previews.get(id) ?? null; }
  async consumePreviewAndCreateJob(previewId: string, job: Job) {
    const replayId = this.idempotency.get(`${job.userId}:${job.idempotencyKey}`);
    if (replayId) return { job: this.jobs.get(replayId)!, replay: true };
    const preview = this.previews.get(previewId);
    if (!preview || preview.usedAt) throw new Error("Preview has already been consumed");
    preview.usedAt = Date.now();
    this.jobs.set(job.id, job);
    this.idempotency.set(`${job.userId}:${job.idempotencyKey}`, job.id);
    return { job, replay: false };
  }
  async getJobForUser(id: string, userId: string) { const job = this.jobs.get(id); return job?.userId === userId ? job : null; }
  async leaseNextJob(device: Device, now: number) {
    const job = [...this.jobs.values()].find((j) => j.userId === device.userId && (!j.deviceId || j.deviceId === device.id) && j.state === "queued" && j.expiresAt > now);
    if (!job) return null;
    const leaseToken = newSecret();
    job.deviceId = device.id;
    job.state = "leased";
    job.leaseTokenHash = digest(leaseToken);
    job.leaseExpiresAt = now + 30_000;
    return { ...job, leaseToken };
  }
  async completeJob(device: Device, jobId: string, leaseTokenHash: string, result: unknown) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== device.userId || job.deviceId !== device.id || job.state !== "leased" || job.leaseTokenHash !== leaseTokenHash || (job.leaseExpiresAt ?? 0) < Date.now()) return null;
    job.state = typeof result === "object" && result !== null && "ok" in result && (result as { ok: unknown }).ok === true ? "succeeded" : "failed";
    job.result = result;
    return job;
  }
}

class PersistentBridgeStore implements BridgeStore {
  constructor(private readonly memory = new MemoryBridgeStore()) {}
  createPairing(value: Pairing) { return this.memory.createPairing(value); }
  claimPairing(codeHash: string, now: number) { return this.memory.claimPairing(codeHash, now); }
  createDevice(value: Device) { return this.memory.createDevice(value); }
  getDevice(id: string) { return this.memory.getDevice(id); }
  touchDevice(id: string, at: number) { return this.memory.touchDevice(id, at); }
  async createPreview(value: Preview) { await persistPreview(value); await this.memory.createPreview(value); }
  async getPreview(id: string, userId?: string) {
    const cached = await this.memory.getPreview(id);
    if (cached) return !userId || cached.userId === userId ? cached : null;
    if (!userId) return null;
    const persisted = await readPreview(id, userId);
    if (persisted) await this.memory.createPreview(persisted);
    return persisted;
  }
  consumePreviewAndCreateJob(previewId: string, job: Job) { return this.memory.consumePreviewAndCreateJob(previewId, job); }
  getJobForUser(id: string, userId: string) { return this.memory.getJobForUser(id, userId); }
  leaseNextJob(device: Device, now: number) { return this.memory.leaseNextJob(device, now); }
  completeJob(device: Device, jobId: string, leaseTokenHash: string, result: unknown) { return this.memory.completeJob(device, jobId, leaseTokenHash, result); }
}

const globalStore = globalThis as typeof globalThis & { __canvasBridgeStore?: BridgeStore };
export const bridgeStore: BridgeStore = globalStore.__canvasBridgeStore ??= process.env.DATABASE_URL ? new PersistentBridgeStore() : new MemoryBridgeStore();
