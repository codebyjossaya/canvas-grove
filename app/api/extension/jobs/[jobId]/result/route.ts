import { authenticateDevice } from "@/lib/bridge/device-auth";
import { body, errorJson, json } from "@/lib/bridge/http";
import { digest } from "@/lib/bridge/crypto";
import { bridgeStore } from "@/lib/bridge/store";

function containsSecretMaterial(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    /^(cookie|set-cookie|authorization|x-csrf-token|csrf|headers)$/i.test(key) || containsSecretMaterial(item));
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const device = await authenticateDevice(request);
  if (!device) return errorJson(new Error("Invalid device credentials"), 401);
  try {
    const input = await body(request);
    const leaseToken = String(input.leaseToken || "");
    if (!leaseToken) throw new Error("leaseToken is required");
    const result = input.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("A result object is required");
    if (containsSecretMaterial(result)) throw new Error("Result contains forbidden credential material");
    const serialized = JSON.stringify(result);
    if (serialized.length > 240_000) throw new Error("Result is too large");
    const { jobId } = await context.params;
    const job = await bridgeStore.completeJob(device, jobId, digest(leaseToken), result);
    if (!job) return errorJson(new Error("Job lease is invalid or expired"), 409);
    return json({ ok: true, state: job.state });
  } catch (error) { return errorJson(error); }
}
