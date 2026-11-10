import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedBrowserState } from "../hosted-browser";

function masterKey(): Buffer {
  const encoded = process.env.BROWSER_STATE_KEK;
  if (!encoded) throw new Error("BROWSER_STATE_KEK is required for hosted browser persistence");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("BROWSER_STATE_KEK must be a base64-encoded 32-byte key");
  return key;
}

function encryptWithKey(plaintext: Buffer, key: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Envelope encryption: a random data key encrypts state; the configured KEK wraps only that key. */
export function envelopeEncryptBrowserState(value: unknown, ownerId: string): EncryptedBrowserState {
  const aad = Buffer.from(`canvas-grove:browser-state:${ownerId}`, "utf8");
  const dataKey = randomBytes(32);
  const encrypted = encryptWithKey(Buffer.from(JSON.stringify(value), "utf8"), dataKey, aad);
  const wrapped = encryptWithKey(dataKey, masterKey(), aad);
  dataKey.fill(0);
  return {
    algorithm: "AES-256-GCM",
    keyId: process.env.BROWSER_STATE_KEK_ID || "local-v1",
    ciphertext: encrypted.ciphertext.toString("base64"),
    iv: encrypted.iv.toString("base64"),
    authTag: encrypted.authTag.toString("base64"),
    wrappedDataKey: [wrapped.iv, wrapped.authTag, wrapped.ciphertext].map((part) => part.toString("base64url")).join("."),
  };
}

function decryptWithKey(ciphertext: Buffer, key: Buffer, iv: Buffer, authTag: Buffer, aad: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Decrypt only inside the trusted browser provider; plaintext is never persisted or returned by an HTTP route. */
export function envelopeDecryptBrowserState(state: EncryptedBrowserState, ownerId: string): unknown {
  if (state.algorithm !== "AES-256-GCM") throw new Error("Unsupported browser state encryption algorithm");
  const aad = Buffer.from(`canvas-grove:browser-state:${ownerId}`, "utf8");
  const wrappedParts = state.wrappedDataKey.split(".");
  if (wrappedParts.length !== 3) throw new Error("Invalid wrapped browser state key");
  const [wrappedIv, wrappedTag, wrappedCiphertext] = wrappedParts.map((part) => Buffer.from(part, "base64url"));
  const dataKey = decryptWithKey(wrappedCiphertext, masterKey(), wrappedIv, wrappedTag, aad);
  try {
    const plaintext = decryptWithKey(Buffer.from(state.ciphertext, "base64"), dataKey, Buffer.from(state.iv, "base64"), Buffer.from(state.authTag, "base64"), aad);
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    dataKey.fill(0);
  }
}
