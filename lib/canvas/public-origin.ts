import "server-only";
import { lookup } from "node:dns/promises";
import { normalizeCanvasOrigin } from "./institution";
import { isPublicAddress } from "./network-policy";

export async function validatePublicCanvasOrigin(value: unknown): Promise<string> {
  const origin = normalizeCanvasOrigin(value);
  const hostname = new URL(origin).hostname;
  await validatePublicHostname(hostname);
  return origin;
}

/** Resolve every configured institution/SSO hostname before it enters a browser allowlist. */
export async function validatePublicHostname(hostname: string): Promise<string> {
  let addresses: Array<{ address: string }>;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error("That Canvas hostname could not be resolved"); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Institution hosts must resolve only to public internet addresses");
  }
  return hostname;
}
