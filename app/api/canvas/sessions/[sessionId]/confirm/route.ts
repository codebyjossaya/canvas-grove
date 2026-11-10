import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { errorJson, json } from "@/lib/bridge/http";
import { hostedBrowserProvider, hostedSessionStore, publicHostedSession } from "@/lib/bridge/hosted-browser";
import { completeAuthenticationTx, findPendingAuthMonitorTx, releaseLoginBrowser } from "@/lib/bridge/complete-authentication";
import { normalizeBridgeError } from "@/lib/bridge/errors";
import { runSingleFlight } from "@/lib/bridge/single-flight";
import { withTenantSql } from "@/lib/db";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "@/lib/rate-limit";

// Fast, user-triggered sign-in confirmation. The viewer reports that the remote
// browser landed on Canvas; this runs the same status -> snapshot -> transactional
// finalizer the durable monitor runs, so the popup can close immediately. The
// monitor stays the backstop; whichever caller locks the monitor row first wins
// and every other call is an idempotent no-op.
const globals = globalThis as typeof globalThis & { __hostedConfirmFlights?: Map<string, Promise<boolean>> };
const confirmFlights = globals.__hostedConfirmFlights ??= new Map<string, Promise<boolean>>();

export async function POST(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return errorJson(new Error("Authentication required"), 401);
  const ownerId = authSession.userId;
  const limited = checkRateLimit(RATE_LIMITS.authConfirm, ownerId);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSeconds);
  const { sessionId } = await context.params;
  const hosted = await hostedSessionStore.getForOwner(sessionId, ownerId);
  if (!hosted) return errorJson(new Error("Hosted session not found"), 404);
  if (hosted.state === "active") return json({ confirmed: true, session: publicHostedSession(hosted) });
  const providerSessionId = hosted.providerSessionId;
  if (!providerSessionId || ["terminated", "failed"].includes(hosted.state)) return json({ confirmed: false, session: publicHostedSession(hosted) });
  try {
    const confirmed = await runSingleFlight(confirmFlights, `${ownerId}:${hosted.id}`, async () => {
      const status = await hostedBrowserProvider.status(providerSessionId);
      if (status.state !== "active" || !status.canvasAccountId) return false;
      // Tenant scope (RLS app.user_id) and the encryption AAD use the database
      // owner UUID, exactly as the worker does; the Clerk id is not a uuid.
      const tenantId = hosted.userId;
      const { monitor, sessionStatus } = await withTenantSql(tenantId, (tx) => findPendingAuthMonitorTx(tx, tenantId, hosted.id));
      if (!monitor) return sessionStatus === "active";
      const encrypted = await hostedBrowserProvider.snapshotEncrypted(providerSessionId, tenantId);
      const won = await withTenantSql(tenantId, (tx) => completeAuthenticationTx(tx, monitor, status.canvasAccountId!, encrypted));
      // The browser is login-only: once the cookies are committed it is
      // destroyed. Defer it until after the popup has its answer so the user
      // never sees a disconnect.
      if (won) after(() => releaseLoginBrowser(hostedBrowserProvider, providerSessionId).then(() => undefined, () => undefined));
      return won;
    });
    const latest = (await hostedSessionStore.getForOwner(hosted.id, ownerId)) ?? hosted;
    return json({ confirmed: confirmed || latest.state === "active", session: publicHostedSession(latest) });
  } catch (error) {
    const normalized = normalizeBridgeError(error);
    console.warn("hosted_confirm_failed", { sessionId, code: normalized.code, status: normalized.status });
    return errorJson(normalized);
  }
}
