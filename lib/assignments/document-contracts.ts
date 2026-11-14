import type { CanvasRequest } from "@/lib/bridge/types";
import { CourseUploadError, COURSE_UPLOAD_MAX_BYTES, parseCourseUploadMeta, type CourseUploadMeta } from "@/lib/courses/upload-contracts";

export type AssignmentDocumentMeta = CourseUploadMeta & { sha256: string };

export function parseAssignmentDocumentMeta(value: { filename?: unknown; contentType?: unknown; size?: unknown; sha256?: unknown }, maxBytes = COURSE_UPLOAD_MAX_BYTES): AssignmentDocumentMeta {
  const file = parseCourseUploadMeta({ ...value, folderId: null }, maxBytes);
  const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new CourseUploadError("INVALID_FILE_DIGEST", "The document digest is missing or invalid.");
  return { ...file, sha256 };
}

const canvasId = (value: string, label: string) => {
  if (!/^\d{1,20}$/.test(value)) throw new CourseUploadError("INVALID_CANVAS_ID", `Canvas returned an invalid ${label}.`, 502);
  return value;
};

/** Canvas's assignment-scoped file handshake. This is intentionally not the course Files endpoint. */
export function assignmentDocumentHandshakeRequest(courseId: string, assignmentId: string, meta: AssignmentDocumentMeta): CanvasRequest {
  return {
    method: "POST",
    path: `/api/v1/courses/${canvasId(courseId, "course id")}/assignments/${canvasId(assignmentId, "assignment id")}/submissions/self/files`,
    body: { name: meta.filename, size: meta.size, content_type: meta.contentType, on_duplicate: "rename" },
  };
}

/** Binds idempotency to the exact bytes without sending the digest to Canvas. */
export function assignmentDocumentOperationRequest(courseId: string, assignmentId: string, meta: AssignmentDocumentMeta): CanvasRequest {
  const request = assignmentDocumentHandshakeRequest(courseId, assignmentId, meta);
  return { ...request, body: { ...request.body, grove_sha256: meta.sha256 } };
}
