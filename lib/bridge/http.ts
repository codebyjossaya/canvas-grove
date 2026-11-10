import "server-only";
import { bridgeErrorBody, normalizeBridgeError } from "./errors";

export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export const errorJson = (error: unknown, status?: number) => {
  const normalized = normalizeBridgeError(error);
  return json(bridgeErrorBody(normalized), status ?? normalized.status);
};

export async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 256_000) throw new Error("Request body is too large");
  const parsed: unknown = await request.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A JSON object is required");
  return parsed as Record<string, unknown>;
}
