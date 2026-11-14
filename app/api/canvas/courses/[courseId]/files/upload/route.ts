import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { json } from "@/lib/bridge/http";
import { CourseUploadError, COURSE_UPLOAD_MAX_BYTES, parseCourseUploadMeta } from "@/lib/courses/upload-contracts";
import { uploadCourseDocument } from "@/lib/courses/upload";

export const instant = false;

const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

async function* requestBytes(request: Request): AsyncGenerator<Uint8Array> {
  if (!request.body) throw new CourseUploadError("EMPTY_UPLOAD", "Choose a document to upload.");
  const reader = request.body.getReader();
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; yield next.value; }
  } finally { reader.releaseLock(); }
}

/** Raw request bytes are streamed into Canvas's multipart upload; Grove never buffers the browser file. */
export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  if (request.headers.get("x-grove-csrf") !== "1") return json({ error: "Same-origin upload confirmation is required", code: "CSRF_REQUIRED" }, 403);
  try {
    const key = request.headers.get("x-idempotency-key") ?? "";
    if (!IDEMPOTENCY.test(key)) throw new CourseUploadError("INVALID_IDEMPOTENCY_KEY", "A valid 16-128 character retry key is required.");
    let filename: string;
    try { filename = decodeURIComponent(request.headers.get("x-grove-file-name") ?? ""); }
    catch { throw new CourseUploadError("INVALID_FILENAME", "The filename header is invalid."); }
    const declared = Number(request.headers.get("x-grove-file-size"));
    const transportLength = request.headers.get("content-length");
    if (transportLength !== null && Number(transportLength) !== declared) throw new CourseUploadError("FILE_SIZE_MISMATCH", "The request size does not match the selected file.");
    const meta = parseCourseUploadMeta({ filename, contentType: request.headers.get("content-type"), size: declared, folderId: request.headers.get("x-grove-folder-id") }, COURSE_UPLOAD_MAX_BYTES);
    const { courseId } = await context.params;
    const receipt = await uploadCourseDocument(await ensureUserForClerk(session.userId), courseId, meta, requestBytes(request), key);
    return json(receipt, receipt.replay ? 200 : 201);
  } catch (error) {
    if (error instanceof CourseUploadError) return json({ error: error.message, code: error.code }, error.status);
    console.error("course_file_upload_failed", { error: error instanceof Error ? error.name : "unknown" });
    return json({ error: "Grove could not complete the upload.", code: "UPLOAD_FAILED" }, 500);
  }
}
