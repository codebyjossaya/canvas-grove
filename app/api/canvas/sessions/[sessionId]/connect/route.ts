import { auth } from "@clerk/nextjs/server";
import { errorJson, json } from "@/lib/bridge/http";
import { hostedBrowserProvider, hostedSessionStore } from "@/lib/bridge/hosted-browser";
import { BridgeError, normalizeBridgeError } from "@/lib/bridge/errors";
import { runSingleFlight } from "@/lib/bridge/single-flight";
import { body } from "@/lib/bridge/http";
import { normalizeDisplay } from "@/lib/bridge/display";

type Connection = { url: string; expiresAt: number };
const globals = globalThis as typeof globalThis & { __hostedConnectFlights?: Map<string, Promise<Connection>> };
const connectFlights = globals.__hostedConnectFlights ??= new Map<string, Promise<Connection>>();

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return errorJson(new Error("Authentication required"), 401);
  const { sessionId } = await context.params;
  const hosted = await hostedSessionStore.getForOwner(sessionId, authSession.userId);
  if (!hosted) return errorJson(new Error("Hosted session not found"), 404);
  if (hosted.state === "auth-expired" || hosted.lastError === "INTERACTIVE_AUTH_TIMEOUT") {
    return errorJson(new BridgeError("INTERACTIVE_AUTH_TIMEOUT", "This secure sign-in expired. Start a new secure sign-in to continue.", 409));
  }
  if (!hosted.interactiveAttemptId || !hosted.interactiveAttemptDeadlineAt) {
    return errorJson(new BridgeError("INVALID_SESSION_STATE", "Start a new secure sign-in before connecting.", 409));
  }
  if (hosted.interactiveAttemptDeadlineAt && hosted.interactiveAttemptDeadlineAt <= Date.now()) {
    return errorJson(new BridgeError("INTERACTIVE_AUTH_TIMEOUT", "This secure sign-in expired. Cleanup is finishing; then start a new secure sign-in.", 409));
  }
  if (!["provisioning", "awaiting-login"].includes(hosted.state)) return errorJson(new Error("Session is not awaiting interactive authentication"), 409);
  try {
    const display = normalizeDisplay(await body(request).catch(() => ({})));
    const flightKey = `${authSession.userId}:${hosted.id}`;
    const flight = runSingleFlight(connectFlights, flightKey, async () => {
        let providerSessionId = hosted.providerSessionId;
        let connection: Connection;
        if (!providerSessionId) {
          const provisioned = await hostedBrowserProvider.provision({ ownerId: authSession.userId, canvasOrigin: hosted.canvasOrigin, authHostRules: hosted.authHostRules, loginPath: hosted.loginPath, display });
          providerSessionId = provisioned.providerSessionId;
          const claimed = await hostedSessionStore.updateForOwner(hosted.id, authSession.userId, {
            providerSessionId, state: "awaiting-login", lastError: undefined, interactiveAttemptId: hosted.interactiveAttemptId,
          });
          if (!claimed || claimed.state === "terminated" || claimed.interactiveAttemptId !== hosted.interactiveAttemptId || claimed.providerSessionId !== providerSessionId) {
            await hostedBrowserProvider.terminate(providerSessionId).catch(() => undefined);
            throw new BridgeError("BROWSER_SESSION_NOT_FOUND", "The secure browser session was cancelled.", 404);
          }
        }
        try { connection = await hostedBrowserProvider.interactiveConnect(providerSessionId); }
        catch (error) {
          if (!(error instanceof BridgeError) || !["BROWSER_SESSION_NOT_FOUND", "BROWSER_HOST_ERROR"].includes(error.code)) throw error;
          // A container can remain technically running while Chromium, CDP, or
          // its viewer has failed. Retire that unusable handle once, then let
          // the owner/session single-flight provision exactly one replacement.
          await hostedBrowserProvider.terminate(providerSessionId).catch(() => undefined);
          const replacement = await hostedBrowserProvider.provision({ ownerId: authSession.userId, canvasOrigin: hosted.canvasOrigin, authHostRules: hosted.authHostRules, loginPath: hosted.loginPath, display });
          providerSessionId = replacement.providerSessionId;
          connection = await hostedBrowserProvider.interactiveConnect(providerSessionId);
        }
        const updated = await hostedSessionStore.updateForOwner(hosted.id, authSession.userId, {
          providerSessionId, state: "awaiting-login", liveViewExpiresAt: connection.expiresAt, lastError: undefined, interactiveAttemptId: hosted.interactiveAttemptId,
        });
        if (!updated || updated.state === "terminated" || updated.interactiveAttemptId !== hosted.interactiveAttemptId || updated.providerSessionId !== providerSessionId) {
          await hostedBrowserProvider.terminate(providerSessionId).catch(() => undefined);
          throw new BridgeError("BROWSER_SESSION_NOT_FOUND", "The secure browser session was cancelled.", 404);
        }
        return connection;
      });
    const connection = await flight;
    return json({ url: connection.url, expiresAt: new Date(connection.expiresAt).toISOString() });
  } catch (error) {
    const normalized = normalizeBridgeError(error);
    console.warn("hosted_connect_failed", { sessionId, code: normalized.code, status: normalized.status });
    return errorJson(normalized);
  }
}
