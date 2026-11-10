import { auth } from "@clerk/nextjs/server";
import { agentControlAudit, agentControlStore } from "@/lib/bridge/agent-control";
import { errorJson, json } from "@/lib/bridge/http";
import { hostedSessionStore } from "@/lib/bridge/hosted-browser";

export async function POST(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return errorJson(new Error("Authentication required"), 401);
  const { sessionId } = await context.params;
  const hosted = await hostedSessionStore.getForOwner(sessionId, authSession.userId);
  if (!hosted || !hosted.providerSessionId || hosted.state === "terminated") return errorJson(new Error("Hosted session not found"), 404);
  try {
    const { lease, token } = agentControlStore.acquire(sessionId, authSession.userId);
    await agentControlAudit.record({ ownerId: authSession.userId, sessionId, action: "control.acquire", outcome: "allowed", at: Date.now() });
    // This credential is returned once and is never persisted or audited in plaintext.
    return json({ leaseId: lease.id, leaseToken: token, expiresAt: new Date(lease.expiresAt).toISOString() }, 201);
  } catch (error) {
    await agentControlAudit.record({ ownerId: authSession.userId, sessionId, action: "control.acquire", outcome: "denied", at: Date.now() });
    return errorJson(error, 409);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const authSession = await auth();
  if (!authSession.isAuthenticated || !authSession.userId) return errorJson(new Error("Authentication required"), 401);
  const { sessionId } = await context.params;
  const hosted = await hostedSessionStore.getForOwner(sessionId, authSession.userId);
  if (!hosted) return errorJson(new Error("Hosted session not found"), 404);
  agentControlStore.revokeForOwner(sessionId, authSession.userId);
  await agentControlAudit.record({ ownerId: authSession.userId, sessionId, action: "control.revoke", outcome: "allowed", at: Date.now() });
  return json({ revoked: true });
}
