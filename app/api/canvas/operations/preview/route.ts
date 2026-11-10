import { auth } from "@clerk/nextjs/server";
import { body, errorJson, json } from "@/lib/bridge/http";
import { buildOperation } from "@/lib/bridge/operations";
import { bridgeStore } from "@/lib/bridge/store";
import { canonicalJson, digest, newId } from "@/lib/bridge/crypto";

export async function POST(request: Request) {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  try {
    const input = await body(request);
    const operation = String(input.operation || "");
    const parameters = input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters) ? input.parameters as Record<string, unknown> : {};
    const built = buildOperation(operation, parameters);
    const now = Date.now();
    const preview = {
      id: newId(), userId: session.userId, operation, parameters, ...built,
      digest: digest(canonicalJson({ version: 1, userId: session.userId, operation, parameters, request: built.request })),
      createdAt: now, expiresAt: now + 5 * 60_000,
    };
    await bridgeStore.createPreview(preview);
    return json({ previewId: preview.id, digest: preview.digest, operation, request: preview.request, risk: preview.risk, expiresAt: new Date(preview.expiresAt).toISOString() }, 201);
  } catch (error) { return errorJson(error); }
}
