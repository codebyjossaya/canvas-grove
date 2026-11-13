import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Credential for one paired browser extension: `gfe1.<ownerId>.<deviceId>.<secret>`.
// The owner id is not secret; it only lets the server open the right row-level-security scope
// before it has authenticated anything. The 256-bit secret is what authenticates, and only its
// SHA-256 is stored.

export const TOKEN_VERSION = "gfe1";
export const DEVICE_SCOPE = "canvas-session";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(`^${TOKEN_VERSION}\\.(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);

export type ParsedToken = { ownerId: string; deviceId: string; secret: string };
export type MintedToken = { token: string; deviceId: string; secretHash: string; prefix: string };

export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

export function mintToken(ownerId: string, deviceId: string = randomUUID()): MintedToken {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${TOKEN_VERSION}.${ownerId}.${deviceId}.${secret}`, deviceId, secretHash: hashSecret(secret), prefix: secret.slice(0, 6) };
}

export function parseToken(value: string | null | undefined): ParsedToken | null {
  const match = TOKEN.exec(value ?? "");
  return match ? { ownerId: match[1], deviceId: match[2], secret: match[3] } : null;
}

/** Constant-time comparison of a presented secret against the stored hash. */
export function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashSecret(secret), "hex"), Buffer.from(storedHash, "hex"));
}

export function bearerToken(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

/** A short, safe, human label for a device name typed by the user. */
export function cleanDeviceName(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim() : "";
  return (text || "Browser").slice(0, 60);
}
