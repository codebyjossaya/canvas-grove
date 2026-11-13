// Dev/ops scripts must act ONLY as the developer's own Grove account. The DB holds
// other people's data (other owners' Canvas sessions), and using one of those by
// mistake means acting as someone else in Canvas. Configure via DEV_OWNER_ID or a
// one-line `.dev-owner` file at the repo root (gitignored).
import { readFileSync } from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function devOwnerId(): string {
  let value = process.env.DEV_OWNER_ID?.trim();
  if (!value) { try { value = readFileSync(path.resolve(process.cwd(), ".dev-owner"), "utf8").trim(); } catch { /* not configured */ } }
  value = value?.toLowerCase();
  if (!value || !UUID.test(value)) throw new Error("DEV_OWNER_ID is not configured (.dev-owner at the repo root). Dev scripts only act as the developer's own Grove account.");
  return value;
}

export function assertDevOwner(ownerId: string, what = "this action"): void {
  const dev = devOwnerId();
  if (ownerId.toLowerCase() !== dev) throw new Error(`Refusing ${what}: owner ${ownerId.slice(0, 8)} is not the developer's account (${dev.slice(0, 8)}).`);
}
