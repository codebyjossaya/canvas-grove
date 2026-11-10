import { auth } from "@clerk/nextjs/server";
import { errorJson, json } from "@/lib/bridge/http";
import { executeCanvasApiForSession, hostedBrowserProvider, hostedSessionStore, publicHostedSession } from "@/lib/bridge/hosted-browser";
import { normalizeBridgeError } from "@/lib/bridge/errors";

async function owned(id: string) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return { error: errorJson(new Error("Authentication required"), 401) };
  const hosted = await hostedSessionStore.getForOwner(id, authSession.userId);
  if (!hosted) return { error: errorJson(new Error("Hosted session not found"), 404) };
  return { authSession, hosted };
}

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const result = await owned(sessionId);
  if (result.error) return result.error;
  const { hosted, authSession } = result;
  // An active session has no browser (it is destroyed after cookie capture).
  // "Check connection" verifies the captured cookies over the direct API.
  if (hosted.state === "active") {
    if (new URL(request.url).searchParams.get("verify") !== "1") return json({ session: publicHostedSession(hosted) });
    try {
      await executeCanvasApiForSession(hosted, authSession!.userId!, { method: "GET", path: "/api/v1/users/self" });
      return json({ session: publicHostedSession((await hostedSessionStore.getForOwner(hosted.id, authSession!.userId!)) ?? hosted) });
    } catch (error) { return errorJson(normalizeBridgeError(error)); }
  }
  if (hosted.providerSessionId && !["terminated", "failed"].includes(hosted.state)) {
    try {
      const status = await hostedBrowserProvider.status(hosted.providerSessionId);
      const providerSessionId = hosted.providerSessionId;
      // Authentication success is finalized only by the durable worker. It
      // snapshots encrypted state, upserts the account/sync policy graph and
      // relinquishes interactive control in one attempt-bound transaction.
      // Status polling must never publish a partial "active" state.
      if (status.state === "active") return json({ session: publicHostedSession(hosted) });
      const updated = await hostedSessionStore.updateForOwner(hosted.id, authSession!.userId!, {
        state: status.authRequired ? (status.state === "awaiting-login" ? "awaiting-login" : "auth-expired") : status.state,
        canvasAccountId: status.canvasAccountId,
        providerSessionId,
      });
      return json({ session: publicHostedSession(updated!) });
    } catch (error) {
      if (new URL(request.url).searchParams.get("verify") === "1") return errorJson(normalizeBridgeError(error));
      /* Ordinary status polling may use the last durable state during a brief provider interruption. */
    }
  }
  return json({ session: publicHostedSession(hosted) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const result = await owned(sessionId);
  if (result.error) return result.error;
  const { hosted, authSession } = result;
  if (hosted.state === "terminated") return json({ session: publicHostedSession(hosted), revoked: true });
  if (hosted.providerSessionId) {
    await hostedBrowserProvider.relinquishInteractive(hosted.providerSessionId).catch(() => undefined);
    await hostedBrowserProvider.terminate(hosted.providerSessionId).catch(() => undefined);
  }
  const updated = await hostedSessionStore.revokeForOwner(hosted.id, authSession!.userId!);
  if (!updated) return errorJson(new Error("Hosted session not found"), 404);
  return json({ session: publicHostedSession(updated), revoked: true });
}
