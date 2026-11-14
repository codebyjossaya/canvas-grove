import { json } from "@/lib/bridge/http";
import { requireWebUser } from "@/lib/extension/http";
import { AssignmentSubmissionInputError } from "@/lib/assignments/contracts";
import { assignmentSubmissionError } from "@/lib/assignments/http";
import { getAssignmentDocumentPreview, submitAssignmentDocument } from "@/lib/assignments/document-service";
import { parseAssignmentDocumentMeta } from "@/lib/assignments/document-contracts";
import { CourseUploadError, COURSE_UPLOAD_MAX_BYTES } from "@/lib/courses/upload-contracts";

export const instant = false;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

async function* requestBytes(request: Request): AsyncGenerator<Uint8Array> {
  if (!request.body) throw new CourseUploadError("EMPTY_UPLOAD", "Choose a document to submit.");
  const reader = request.body.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) break; yield next.value; } }
  finally { reader.releaseLock(); }
}

export async function GET(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  try {
    const ctx = await requireWebUser(request);
    if (ctx instanceof Response) return ctx;
    const { assignmentId } = await context.params;
    return json(await getAssignmentDocumentPreview(ctx, assignmentId));
  } catch (error) { return assignmentSubmissionError(error); }
}

/** Raw bytes are streamed to Canvas; Grove never parses multipart or buffers the browser file. */
export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  try {
    const ctx = await requireWebUser(request);
    if (ctx instanceof Response) return ctx;
    const key = request.headers.get("x-idempotency-key") ?? "";
    if (!IDEMPOTENCY.test(key)) throw new AssignmentSubmissionInputError("INVALID_IDEMPOTENCY_KEY", "A valid 16-128 character retry key is required.");
    let filename: string;
    try { filename = decodeURIComponent(request.headers.get("x-grove-file-name") ?? ""); }
    catch { throw new CourseUploadError("INVALID_FILENAME", "The filename header is invalid."); }
    const declared = Number(request.headers.get("x-grove-file-size"));
    const length = request.headers.get("content-length");
    if (length !== null && Number(length) !== declared) throw new CourseUploadError("FILE_SIZE_MISMATCH", "The request size does not match the selected document.");
    const meta = parseAssignmentDocumentMeta({ filename, contentType: request.headers.get("content-type"), size: declared, sha256: request.headers.get("x-grove-file-sha256") }, COURSE_UPLOAD_MAX_BYTES);
    const { assignmentId } = await context.params;
    const receipt = await submitAssignmentDocument(ctx, assignmentId, meta, requestBytes(request), key);
    return json(receipt, receipt.replay ? 200 : 201);
  } catch (error) {
    if (error instanceof CourseUploadError) return json({ error: error.message, code: error.code }, error.status);
    return assignmentSubmissionError(error);
  }
}
