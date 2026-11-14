import { auth } from "@clerk/nextjs/server";
import { body, errorJson, json } from "@/lib/bridge/http";
import { HOSTED_BROWSER_CONSENT_VERSION, hostedSessionStore, newHostedSession, publicHostedSession } from "@/lib/bridge/hosted-browser";
import { normalizeAuthHostRules, normalizeInstitutionName, parseInstitutionLink, requireCanvasLoginPath } from "@/lib/canvas/institution";
import { validatePublicCanvasOrigin } from "@/lib/canvas/public-origin";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  const items = await hostedSessionStore.listForOwner(session.userId);
  return json({ sessions: items.map(publicHostedSession) });
}

export async function POST(request: Request) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return errorJson(new Error("Authentication required"), 401);
  const limited = checkRateLimit(RATE_LIMITS.sessionCreate, authSession.userId);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSeconds);
  try {
    const input = await body(request);
    if (input.consent !== true || input.consentVersion !== HOSTED_BROWSER_CONSENT_VERSION) throw new Error("Current extension authentication consent is required");
    // `signInLink` takes precedence; the legacy origin/path pair remains accepted
    // while clients migrate. Authentication itself happens in the user's browser,
    // so Grove no longer discovers or allowlists identity-provider hosts.
    const hasSignInLink = typeof input.signInLink === "string" && input.signInLink.trim() !== "";
    const link = hasSignInLink ? parseInstitutionLink(input.signInLink) : null;
    const canvasOrigin = await validatePublicCanvasOrigin(link ? link.canvasOrigin : input.canvasOrigin);
    const loginPath = link ? link.loginPath : requireCanvasLoginPath(input.loginPath);
    const institutionName = normalizeInstitutionName(input.institutionName, canvasOrigin);
    const authHostRules = normalizeAuthHostRules([], canvasOrigin);
    const hosted = newHostedSession(authSession.userId, canvasOrigin, institutionName, authHostRules, loginPath);
    await hostedSessionStore.create(hosted);
    return json({ session: publicHostedSession(hosted) }, 201);
  } catch (error) { return errorJson(error); }
}
