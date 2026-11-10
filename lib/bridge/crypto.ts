import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const newId = () => randomUUID();
export const newSecret = () => randomBytes(32).toString("base64url");
export const pairingCode = () => randomBytes(16).toString("base64url").toUpperCase();
export const digest = (value: string) => createHash("sha256").update(value).digest("base64url");

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function safeHashEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
