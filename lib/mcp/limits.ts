import { checkRateLimit, type RateLimitPolicy, type RateLimitResult } from "@/lib/rate-limit";

// Rate limits and caps for the MCP server and its OAuth endpoints. The limiter is the shared
// in-memory sliding window (lib/rate-limit.ts): correct for Grove's single Next.js process only;
// limits reset on restart and are not shared across replicas.

export const MCP_LIMITS = {
  /** Per token on /mcp and /api/mcp/files. */
  mcpToken: { name: "mcp-token", limit: 120, windowMs: 60_000 },
  /** Dynamic client registration, per client IP and globally. */
  registerIp: { name: "mcp-register-ip", limit: 10, windowMs: 60 * 60_000 },
  registerGlobal: { name: "mcp-register-global", limit: 100, windowMs: 60 * 60_000 },
  /** Token and revocation endpoints, per client IP. */
  tokenIp: { name: "mcp-token-ip", limit: 60, windowMs: 60_000 },
  revokeIp: { name: "mcp-revoke-ip", limit: 60, windowMs: 60_000 },
  /** Consent page loads and decisions, per Grove user. */
  consent: { name: "mcp-consent", limit: 30, windowMs: 10 * 60_000 },
  /** Staged/immediate writes, per token. Quiz-session calls use mcpToken only. */
  writeToken: { name: "mcp-write-token", limit: 60, windowMs: 60 * 60_000 },
  /** PAT creation, per Grove user. */
  patCreate: { name: "mcp-pat-create", limit: 20, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

/** Total registered OAuth clients before registration is closed. */
export const MAX_CLIENTS = 5000;
export const MAX_ACTIVE_PATS = 10;
export const MAX_REGISTRATION_BYTES = 8 * 1024;
export const MAX_FORM_BYTES = 8 * 1024;

/** Token/revoke endpoints: key on client_id + caller so one shared proxy address cannot starve every client. */
export const clientKey = (clientId: unknown, headers: Headers) => `${typeof clientId === "string" ? clientId.slice(0, 64) : "-"}|${clientIp(headers)}`;

export const limit = (policy: RateLimitPolicy, key: string, now?: number): RateLimitResult => checkRateLimit(policy, key, now);

/**
 * Rate-limit key for unauthenticated OAuth endpoints. Behind Tailscale serve every request arrives
 * from the same proxy address, so the tailnet identity (`Tailscale-User-Login`, set by Tailscale
 * serve) is used when present. Otherwise the LAST x-forwarded-for hop (the one our own reverse
 * proxy appended), since earlier entries are client-controlled. The global registration limit
 * backstops any spoofing.
 */
export function clientIp(headers: Headers): string {
  const tailnet = headers.get("tailscale-user-login")?.trim();
  if (tailnet && /^[^\s,]{1,200}$/.test(tailnet)) return `ts:${tailnet.toLowerCase()}`.slice(0, 120);
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return (hops.at(-1) ?? headers.get("x-real-ip")?.trim() ?? "unknown").slice(0, 64);
}
