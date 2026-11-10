import { auth } from "@clerk/nextjs/server";
import { body, errorJson, json } from "@/lib/bridge/http";
import { HOSTED_BROWSER_CONSENT_VERSION, hostedSessionStore, newHostedSession, publicHostedSession } from "@/lib/bridge/hosted-browser";
import { mergeDiscoveredAuthHosts, normalizeAuthHostRules, normalizeInstitutionName, parseInstitutionLink, requireCanvasLoginPath } from "@/lib/canvas/institution";
import { validatePublicCanvasOrigin, validatePublicHostname } from "@/lib/canvas/public-origin";
import { discoverInstitutionHosts } from "@/lib/canvas/institution-host-discovery";
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
  // Each creation triggers outbound host discovery against the school's sites.
  const limited = checkRateLimit(RATE_LIMITS.sessionCreate, authSession.userId);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSeconds);
  try {
    const input = await body(request);
    if (input.consent !== true || input.consentVersion !== HOSTED_BROWSER_CONSENT_VERSION) throw new Error("Current hosted-browser consent is required");
    // `signInLink` (one pasted SSO link or Canvas address) takes precedence; the
    // legacy `canvasOrigin` + `loginPath` pair is still accepted.
    const hasSignInLink = typeof input.signInLink === "string" && input.signInLink.trim() !== "";
    const link = hasSignInLink ? parseInstitutionLink(input.signInLink) : null;
    const canvasOrigin = await validatePublicCanvasOrigin(link ? link.canvasOrigin : input.canvasOrigin);
    const loginPath = link ? link.loginPath : requireCanvasLoginPath(input.loginPath);
    const institutionName = normalizeInstitutionName(input.institutionName, canvasOrigin);
    const configuredRules = normalizeAuthHostRules(input.authHostRules, canvasOrigin);
    await Promise.all(configuredRules.map(validatePublicHostname));
    // Best effort (~10s budget): follows /login, any school portal page it lands
    // on, and up to six Canvas sign-in links on that page. Never fails creation.
    const discovered = await discoverInstitutionHosts(canvasOrigin, loginPath).catch(() => ({ hosts: [] as string[] }));
    const authHostRules = normalizeAuthHostRules(mergeDiscoveredAuthHosts(configuredRules, discovered.hosts, canvasOrigin), canvasOrigin);
    const hosted = newHostedSession(authSession.userId, canvasOrigin, institutionName, authHostRules, loginPath);
    await hostedSessionStore.create(hosted);
    return json({ session: publicHostedSession(hosted) }, 201);
  } catch (error) { return errorJson(error); }
}
