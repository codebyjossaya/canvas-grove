// Per-user sliding-window rate limiter for routes that make the server fetch
// third-party hosts (Canvas school search, sign-in host discovery).
//
// In-memory by design: the app runs as a single Next.js process. Limits reset
// on restart and are not shared across replicas — move to Postgres/Redis if the
// app is ever scaled horizontally.

export type RateLimitPolicy = { name: string; limit: number; windowMs: number };

export const RATE_LIMITS = {
  institutionSearch: { name: "institution-search", limit: 30, windowMs: 60_000 },
  sessionCreate: { name: "session-create", limit: 10, windowMs: 10 * 60_000 },
  // The popup retries confirmation for ~10 s after the viewer reports landing.
  authConfirm: { name: "auth-confirm", limit: 40, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

const MAX_TRACKED_KEYS = 10_000;
const hits = new Map<string, number[]>();

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function checkRateLimit(policy: RateLimitPolicy, userId: string, now: number = Date.now()): RateLimitResult {
  const key = `${policy.name}:${userId}`;
  const windowStart = now - policy.windowMs;
  const recent = (hits.get(key) ?? []).filter((at) => at > windowStart);
  if (recent.length >= policy.limit) {
    hits.set(key, recent);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + policy.windowMs - now) / 1000)) };
  }
  recent.push(now);
  hits.delete(key); // re-insert so Map order tracks recency for eviction
  hits.set(key, recent);
  if (hits.size > MAX_TRACKED_KEYS) {
    // Map iteration order is least-recently-used first, so this drops the
    // oldest entries; they are the least likely to still be inside a window.
    for (const staleKey of hits.keys()) {
      if (hits.size <= MAX_TRACKED_KEYS) break;
      hits.delete(staleKey);
    }
  }
  return { allowed: true };
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" } },
  );
}

/** Test helper. */
export function resetRateLimits() { hits.clear(); }
