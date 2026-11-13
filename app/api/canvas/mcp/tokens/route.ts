import { fail, reply, requireWebUser } from "@/lib/extension/http";
import { MCP_LIMITS, limit } from "@/lib/mcp/limits";
import { patExpiryDays } from "@/lib/mcp/oauth-policy";
import { TokenLimitError, createPat } from "@/lib/mcp/store";
import { cleanLabel } from "@/lib/mcp/token";

export const instant = false;

/** Create a personal access token. The token is in this response only; Grove stores its hash. */
export async function POST(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const allowed = limit(MCP_LIMITS.patCreate, ctx.ownerId);
  if (!allowed.allowed) return fail(429, "RATE_LIMITED", "Too many tokens created. Please wait a moment.");
  const body = await request.json().catch(() => null) as { name?: unknown; expiresInDays?: unknown; allowActions?: unknown } | null;
  if (!body || typeof body !== "object") return fail(400, "BAD_REQUEST", "Invalid request.");
  const days = patExpiryDays(body.expiresInDays);
  if (days === undefined) return fail(400, "BAD_EXPIRY", "expiresInDays must be 30, 90, 365 or null.");
  if (body.allowActions !== undefined && typeof body.allowActions !== "boolean") return fail(400, "BAD_REQUEST", "allowActions must be true or false.");
  try {
    const { token, item } = await createPat(ctx, cleanLabel(body.name, "Access token"), days, body.allowActions === true);
    return reply({ token, item }, 201);
  } catch (error) {
    if (error instanceof TokenLimitError) return fail(409, "TOKEN_LIMIT", error.message);
    return fail(500, "CREATE_FAILED", "Could not create the token.");
  }
}
