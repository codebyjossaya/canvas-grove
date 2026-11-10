import "server-only";
import { bridgeStore } from "./store";
import { digest, safeHashEqual } from "./crypto";
import type { Device } from "./types";

export async function authenticateDevice(request: Request): Promise<Device | null> {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Device ([0-9a-f-]+)\.([A-Za-z0-9_-]{20,})$/.exec(authorization);
  if (!match) return null;
  const device = await bridgeStore.getDevice(match[1]);
  if (!device || device.revokedAt || !safeHashEqual(digest(match[2]), device.credentialHash)) return null;
  return device;
}
