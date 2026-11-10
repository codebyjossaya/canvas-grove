import { agentControlAudit, agentControlStore } from "@/lib/bridge/agent-control";
import { errorJson, json } from "@/lib/bridge/http";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const lease = agentControlStore.authenticate(sessionId, request.headers.get("authorization"));
  if (!lease) return errorJson(new Error("Invalid or expired controller lease"), 401);
  agentControlStore.revokeForOwner(sessionId, lease.ownerId);
  await agentControlAudit.record({ ownerId: lease.ownerId, sessionId, action: "control.release", outcome: "allowed", at: Date.now() });
  return json({ released: true });
}
