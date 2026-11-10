import { auth } from "@clerk/nextjs/server";
import { body, errorJson, json } from "@/lib/bridge/http";
import { bridgeStore } from "@/lib/bridge/store";
import { newId } from "@/lib/bridge/crypto";
import type { Job } from "@/lib/bridge/types";
import { executeInHostedSession } from "@/lib/bridge/hosted-browser";

export async function POST(request: Request) {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  try {
    const input = await body(request);
    const previewId = String(input.previewId || "");
    const idempotencyKey = String(input.idempotencyKey || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) throw new Error("A valid 16-128 character idempotency key is required");
    const preview = await bridgeStore.getPreview(previewId, session.userId);
    if (!preview || preview.userId !== session.userId) return errorJson(new Error("Preview not found"), 404);
    if (preview.expiresAt < Date.now()) return errorJson(new Error("Preview expired"), 410);
    if (String(input.digest || "") !== preview.digest) return errorJson(new Error("Preview digest does not match"), 409);
    if (preview.risk !== "read" && input.confirmed !== true) return errorJson(new Error("Explicit confirmation is required"), 409);
    if (preview.risk === "consequential-write" && input.riskAcknowledgement !== "I understand this changes Canvas") {
      return errorJson(new Error("Consequential action acknowledgement is required"), 409);
    }
    if (typeof input.sessionId === "string" && input.sessionId) {
      const result = await executeInHostedSession({ ownerId: session.userId, sessionId: input.sessionId, idempotencyKey, request: preview.request });
      return json({ mode: "hosted-browser", ...result }, result.authRequired ? 401 : result.ok ? 200 : 502);
    }
    const now = Date.now();
    const job: Job = { id: newId(), userId: session.userId, deviceId: typeof input.deviceId === "string" ? input.deviceId : undefined, previewId, request: preview.request, risk: preview.risk, state: "queued", idempotencyKey, createdAt: now, expiresAt: now + (preview.risk === "read" ? 10 * 60_000 : 2 * 60_000) };
    const created = await bridgeStore.consumePreviewAndCreateJob(previewId, job);
    return json({ mode: "extension-fallback", jobId: created.job.id, state: created.job.state, replay: created.replay }, created.replay ? 200 : 202);
  } catch (error) { return errorJson(error); }
}
