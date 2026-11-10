import { agentControlAudit, agentControlStore } from "@/lib/bridge/agent-control";
import { body, errorJson, json } from "@/lib/bridge/http";
import { hostedBrowserProvider, hostedSessionStore } from "@/lib/bridge/hosted-browser";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const lease = agentControlStore.authenticate(sessionId, request.headers.get("authorization"));
  if (!lease) return errorJson(new Error("Invalid or expired controller lease"), 401);
  const hosted = await hostedSessionStore.getForOwner(sessionId, lease.ownerId);
  if (!hosted?.providerSessionId || hosted.state === "terminated") return errorJson(new Error("Hosted session not found"), 404);
  try {
    const input = await body(request);
    const destination = input.destination;
    if (destination !== "canvas-home" && destination !== "canvas-login") throw new Error("Unsupported navigation destination");
    await hostedBrowserProvider.navigate(hosted.providerSessionId, destination);
    await agentControlAudit.record({ ownerId: lease.ownerId, sessionId, action: `navigate.${destination}`, outcome: "allowed", at: Date.now() });
    return json({ ok: true });
  } catch (error) {
    await agentControlAudit.record({ ownerId: lease.ownerId, sessionId, action: "navigate", outcome: "denied", at: Date.now() });
    return errorJson(error);
  }
}
