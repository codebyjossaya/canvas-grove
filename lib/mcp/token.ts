import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Grove MCP credentials, same shape as the extension device token:
//   tokens (PAT / OAuth access / OAuth refresh): `gmt1.<ownerId>.<tokenId>.<secret>`
//   authorization codes:                        `gmc1.<ownerId>.<codeId>.<secret>`
// The owner id is not secret; it only opens the right row-level-security scope before anything is
// authenticated. The 256-bit secret authenticates, and only its SHA-256 is stored.
// Pure module (no server-only): shared by route handlers and unit tests.

export const TOKEN_VERSION = "gmt1";
export const CODE_VERSION = "gmc1";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const pattern = (version: string) => new RegExp(`^${version}\\.(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const TOKEN = pattern(TOKEN_VERSION);
const CODE = pattern(CODE_VERSION);
const OWNER = new RegExp(`^${UUID}$`);

export type ParsedSecret = { ownerId: string; id: string; secret: string };
export type MintedSecret = { value: string; id: string; hash: string; prefix: string };

export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

function mint(version: string, ownerId: string, id: string): MintedSecret {
  if (!OWNER.test(ownerId) || !OWNER.test(id)) throw new Error("Invalid owner or credential id");
  const secret = randomBytes(32).toString("base64url");
  return { value: `${version}.${ownerId}.${id}.${secret}`, id, hash: hashSecret(secret), prefix: secret.slice(0, 6) };
}

export const mintToken = (ownerId: string, id: string = randomUUID()) => mint(TOKEN_VERSION, ownerId, id);
export const mintCode = (ownerId: string, id: string = randomUUID()) => mint(CODE_VERSION, ownerId, id);

function parse(re: RegExp, value: unknown): ParsedSecret | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const match = re.exec(value);
  return match ? { ownerId: match[1], id: match[2], secret: match[3] } : null;
}

export const parseToken = (value: unknown) => parse(TOKEN, value);
export const parseCode = (value: unknown) => parse(CODE, value);

/** Constant-time comparison of a presented secret against the stored SHA-256 hash. */
export function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashSecret(secret), "hex"), Buffer.from(storedHash, "hex"));
}

/** Constant-time string equality (hashes both sides so lengths never leak). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()) && a.length === b.length;
}

export function bearerToken(request: Request): string | null {
  const match = /^Bearer[ ]+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

/** A short, safe, human label typed by the user (token names, client names). */
export function cleanLabel(value: unknown, fallback: string, max = 60): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}
