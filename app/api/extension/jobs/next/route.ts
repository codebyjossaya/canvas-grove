import { authenticateDevice } from "@/lib/bridge/device-auth";
import { errorJson, json } from "@/lib/bridge/http";
import { bridgeStore } from "@/lib/bridge/store";

export async function GET(request: Request) {
  const device = await authenticateDevice(request);
  if (!device) return errorJson(new Error("Invalid device credentials"), 401);
  const now = Date.now();
  await bridgeStore.touchDevice(device.id, now);
  const job = await bridgeStore.leaseNextJob(device, now);
  if (!job) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  return json({ jobId: job.id, leaseToken: job.leaseToken, request: job.request, risk: job.risk, expiresAt: new Date(job.expiresAt).toISOString() });
}
