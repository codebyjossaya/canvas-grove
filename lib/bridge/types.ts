export type Risk = "read" | "reversible-write" | "consequential-write" | "disabled";

export type Pairing = {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: number;
  usedAt?: number;
  attempts: number;
};

export type Device = {
  id: string;
  userId: string;
  name: string;
  canvasOrigin: string;
  credentialHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
};

export type Preview = {
  id: string;
  userId: string;
  operation: string;
  parameters: Record<string, unknown>;
  request: CanvasRequest;
  digest: string;
  risk: Risk;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
};

export type CanvasRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
};

export type JobState = "queued" | "leased" | "succeeded" | "failed" | "cancelled" | "unknown";

export type Job = {
  id: string;
  userId: string;
  deviceId?: string;
  previewId: string;
  request: CanvasRequest;
  risk: Risk;
  state: JobState;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
  leaseTokenHash?: string;
  leaseExpiresAt?: number;
  result?: unknown;
};

export interface BridgeStore {
  createPairing(pairing: Pairing): Promise<void>;
  claimPairing(codeHash: string, now: number): Promise<Pairing | null>;
  createDevice(device: Device): Promise<void>;
  getDevice(id: string): Promise<Device | null>;
  touchDevice(id: string, at: number): Promise<void>;
  createPreview(preview: Preview): Promise<void>;
  getPreview(id: string, userId?: string): Promise<Preview | null>;
  consumePreviewAndCreateJob(previewId: string, job: Job): Promise<{ job: Job; replay: boolean }>;
  getJobForUser(id: string, userId: string): Promise<Job | null>;
  leaseNextJob(device: Device, now: number): Promise<(Job & { leaseToken: string }) | null>;
  completeJob(device: Device, jobId: string, leaseTokenHash: string, result: unknown): Promise<Job | null>;
}
