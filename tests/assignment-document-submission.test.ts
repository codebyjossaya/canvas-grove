import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assignmentDocumentHandshakeRequest, assignmentDocumentOperationRequest, parseAssignmentDocumentMeta } from "../lib/assignments/document-contracts";
import { CourseUploadError, MCP_UPLOAD_MAX_BYTES } from "../lib/courses/upload-contracts";
import { TOOL_CATEGORY } from "../lib/mcp/categories";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");
const digest = "a".repeat(64);

test("assignment document metadata enforces filename, MIME, size, and digest", () => {
  assert.deepEqual(parseAssignmentDocumentMeta({ filename: "HW 4.pdf", contentType: "application/pdf", size: 42, sha256: digest }), {
    filename: "HW 4.pdf", contentType: "application/pdf", size: 42, folderId: null, sha256: digest,
  });
  for (const bad of [
    { filename: "../work.pdf", contentType: "application/pdf", size: 42, sha256: digest },
    { filename: "work.pdf", contentType: "text/plain", size: 42, sha256: digest },
    { filename: "work.pdf", contentType: "application/pdf", size: 0, sha256: digest },
    { filename: "work.pdf", contentType: "application/pdf", size: 42, sha256: "nope" },
  ]) assert.throws(() => parseAssignmentDocumentMeta(bad), CourseUploadError);
});

test("handshake is assignment-scoped and digest only binds Grove idempotency", () => {
  const meta = parseAssignmentDocumentMeta({ filename: "HW 4.pdf", contentType: "application/pdf", size: 42, sha256: digest });
  const canvas = assignmentDocumentHandshakeRequest("12", "34", meta);
  assert.equal(canvas.path, "/api/v1/courses/12/assignments/34/submissions/self/files");
  assert.deepEqual(canvas.body, { name: "HW 4.pdf", size: 42, content_type: "application/pdf", on_duplicate: "rename" });
  assert.equal((assignmentDocumentOperationRequest("12", "34", meta).body as Record<string, unknown>).grove_sha256, digest);
  assert.equal((canvas.body as Record<string, unknown>).grove_sha256, undefined);
});

test("browser route is authenticated, CSRF protected, bounded, and streaming", () => {
  const route = source("app/api/canvas/assignments/[assignmentId]/document/route.ts");
  assert.match(route, /requireWebUser\(request\)/);
  assert.match(route, /parseAssignmentDocumentMeta/);
  assert.match(route, /request\.body\.getReader\(\)/);
  assert.doesNotMatch(route, /formData\(|arrayBuffer\(/);
  assert.match(route, /x-idempotency-key/);
  assert.match(route, /x-grove-file-sha256/);
});

test("service checks eligibility before upload and again through shared submit", () => {
  const service = source("lib/assignments/document-service.ts");
  const firstCheck = service.indexOf("livePreview(ctx, target, session)");
  const upload = service.indexOf("uploadCanvasStorage(");
  const submit = service.indexOf("submitAssignment(ctx, assignmentId");
  assert.ok(firstCheck >= 0 && upload > firstCheck && submit > upload);
  assert.match(service, /where a\.owner_id=\$\{ctx\.ownerId\}/);
  assert.match(service, /type: "online_upload"/);
  assert.match(service, /createHash\("sha256"\)/);
  assert.match(service, /timingSafeEqual\(actual, expected\)/);
  assert.match(service, /verifiedSource\(source, meta\.sha256\)/);
  assert.match(service, /FILE_DIGEST_MISMATCH_STATUS_UNKNOWN/);
  assert.match(service, /Canvas stored the document, but Grove did not confirm/);
});

test("assignment UI previews exact target, file, and attempt before confirmation", () => {
  const ui = source("components/workspace/assignment-document-submission.tsx");
  for (const label of ["Course", "Assignment", "Document", "Type", "Size", "Attempt"]) assert.match(ui, new RegExp(`>${label}<`));
  assert.match(ui, /I reviewed the course, assignment, document, and attempt/);
  assert.match(ui, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(ui, /Check this assignment in Canvas before retrying/);
  assert.match(ui, /FILE_DIGEST_MISMATCH_STATUS_UNKNOWN/);
});

test("MCP takes bounded base64 only and can never enter auto mode", () => {
  const tool = source("lib/mcp/assignment-document.ts");
  assert.match(tool, /submit_assignment_document/);
  assert.match(tool, /contentBase64/);
  assert.match(tool, /MCP_UPLOAD_MAX_BYTES/);
  assert.doesNotMatch(tool, /hostPath|filePath|readFileSync/);
  assert.equal(MCP_UPLOAD_MAX_BYTES, 512 * 1024);
  assert.equal(TOOL_CATEGORY.submit_assignment_document ?? null, null);
  assert.match(tool, /outcome\.action\.status !== "awaiting_approval"/);
  assert.match(tool, /getAssignmentDocumentPreview/);
});
