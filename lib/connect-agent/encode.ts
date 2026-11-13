// Encoding helpers. Pure, work in Node and the browser.

export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** POSIX single-quote a value unless it is plainly safe. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** TOML basic string. JSON string escaping is a valid subset (control chars use \uXXXX). */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Accept only an absolute http(s) URL; strip a trailing slash. Throws on anything else. */
export function normalizeServerUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Server URL must be http(s)");
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
