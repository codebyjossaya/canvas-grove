import { auth } from "@clerk/nextjs/server";
import { errorJson, json } from "@/lib/bridge/http";
import { hostedSessionStore, publicHostedSession } from "@/lib/bridge/hosted-browser";
import { normalizeBridgeError } from "@/lib/bridge/errors";

export async function POST(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return errorJson(new Error("Authentication required"), 401);
  const { sessionId } = await context.params;
  try {
    const session = await hostedSessionStore.startNewInteractiveAttempt(sessionId, authSession.userId);
    if (!session) return errorJson(new Error("Hosted session not found"), 404);
    return json({ session: publicHostedSession(session) });
  } catch (error) {
    return errorJson(normalizeBridgeError(error));
  }
}
