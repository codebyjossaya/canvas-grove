import "server-only";
import { json } from "@/lib/bridge/http";
import { AssignmentSubmissionInputError } from "./contracts";

const MAX_ASSIGNMENT_BODY_BYTES = 256_000;

/** Bounded JSON reader; Content-Length is only a hint, so chunked bodies are counted too. */
export async function assignmentBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_ASSIGNMENT_BODY_BYTES) throw new AssignmentSubmissionInputError("REQUEST_TOO_LARGE", "The submission request is too large.", 413);
  if (!request.body) throw new AssignmentSubmissionInputError("INVALID_REQUEST", "A JSON object is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ASSIGNMENT_BODY_BYTES) { await reader.cancel().catch(() => undefined); throw new AssignmentSubmissionInputError("REQUEST_TOO_LARGE", "The submission request is too large.", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AssignmentSubmissionInputError("INVALID_REQUEST", "A valid JSON object is required."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AssignmentSubmissionInputError("INVALID_REQUEST", "A JSON object is required.");
  return parsed as Record<string, unknown>;
}

export function assignmentSubmissionError(error: unknown) {
  if (error instanceof Error && error.message.includes("During prerendering")) throw error;
  if (error instanceof AssignmentSubmissionInputError) return json({ error: error.message, code: error.code }, error.status);
  console.error("assignment_submission_failed", { error: error instanceof Error ? error.name : "unknown" });
  return json({ error: "Grove could not confirm this assignment submission. Check Canvas before trying again.", code: "ASSIGNMENT_SUBMISSION_FAILED" }, 500);
}
