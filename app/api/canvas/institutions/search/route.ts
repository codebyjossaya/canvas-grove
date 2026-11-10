import { auth } from "@clerk/nextjs/server";
import { errorJson } from "@/lib/bridge/http";
import { InstitutionSearchUnavailableError, searchCanvasInstitutions } from "@/lib/canvas/institution-search";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "@/lib/rate-limit";

// Results are public directory data and identical for every user, so let the
// browser reuse them briefly; `private` keeps shared caches out of it because
// the route itself sits behind Clerk.
const CACHE_HEADERS = { "cache-control": "private, max-age=300" };

export async function GET(request: Request) {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  const limited = checkRateLimit(RATE_LIMITS.institutionSearch, session.userId);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSeconds);
  try {
    const results = await searchCanvasInstitutions(new URL(request.url).searchParams.get("q"));
    return Response.json({ results }, { headers: CACHE_HEADERS });
  } catch (error) {
    return errorJson(error, error instanceof InstitutionSearchUnavailableError ? 502 : 400);
  }
}
