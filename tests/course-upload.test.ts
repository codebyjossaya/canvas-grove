import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CourseUploadError,
  COURSE_UPLOAD_MAX_BYTES,
  MCP_UPLOAD_MAX_BYTES,
  decodeBase64Document,
  multipartEnvelope,
  nextCanvasUploadRedirect,
  parseCourseUploadMeta,
  validateCanvasUploadUrl,
} from "../lib/courses/upload-contracts";

const ORIGIN = "https://school.instructure.com";

test("document validation binds safe names, extensions, MIME types, folders and size", () => {
  assert.deepEqual(parseCourseUploadMeta({ filename: "Lab report.pdf", contentType: "application/pdf", size: 12, folderId: "42" }), {
    filename: "Lab report.pdf", contentType: "application/pdf", size: 12, folderId: "42",
  });
  assert.equal(parseCourseUploadMeta({ filename: "notes.txt", contentType: "application/octet-stream", size: 1 }).contentType, "text/plain");
  for (const input of [
    { filename: "../secret.pdf", contentType: "application/pdf", size: 1 },
    { filename: "bad\nname.pdf", contentType: "application/pdf", size: 1 },
    { filename: "malware.exe", contentType: "application/octet-stream", size: 1 },
    { filename: "paper.pdf", contentType: "text/html", size: 1 },
    { filename: "paper.pdf", contentType: "application/pdf", size: 0 },
    { filename: "paper.pdf", contentType: "application/pdf", size: COURSE_UPLOAD_MAX_BYTES + 1 },
    { filename: "paper.pdf", contentType: "application/pdf", size: 1, folderId: "../../1" },
  ]) assert.throws(() => parseCourseUploadMeta(input), CourseUploadError, JSON.stringify(input));
});

test("MCP base64 is canonical and bounded before staging", () => {
  assert.equal(decodeBase64Document(Buffer.from("hello").toString("base64")).toString(), "hello");
  for (const value of ["data:text/plain;base64,aA==", "a===", "####", Buffer.alloc(MCP_UPLOAD_MAX_BYTES + 1).toString("base64")]) {
    assert.throws(() => decodeBase64Document(value), CourseUploadError);
  }
});

test("Canvas storage targets and redirects fail closed without retransmitting bytes", () => {
  assert.equal(validateCanvasUploadUrl("https://school.instructure.com/upload?sig=x", ORIGIN).hostname, "school.instructure.com");
  assert.equal(validateCanvasUploadUrl("https://instructure-uploads.s3.amazonaws.com/key?sig=x", ORIGIN).hostname, "instructure-uploads.s3.amazonaws.com");
  for (const value of ["http://school.instructure.com/upload", "https://127.0.0.1/upload", "https://attacker.example/upload", "https://school.instructure.com:8443/upload"])
    assert.throws(() => validateCanvasUploadUrl(value, ORIGIN), CourseUploadError);
  const storage = new URL("https://instructure-uploads.s3.amazonaws.com/key");
  assert.equal(nextCanvasUploadRedirect(302, "https://school.instructure.com/api/v1/files/9?token=x", storage, ORIGIN)?.hostname, "school.instructure.com");
  assert.equal(nextCanvasUploadRedirect(303, "/done", storage, ORIGIN)?.pathname, "/done");
  assert.throws(() => nextCanvasUploadRedirect(307, "https://school.instructure.com/done", storage, ORIGIN), /retransmit/);
  assert.throws(() => nextCanvasUploadRedirect(302, "https://another-bucket.s3.amazonaws.com/steal", storage, ORIGIN), /cross-host/);
});

test("multipart handshake parameters are bounded and the streamed file is last", () => {
  const meta = parseCourseUploadMeta({ filename: "résumé.pdf", contentType: "application/pdf", size: 123 });
  const output = multipartEnvelope({ key: "course/1", policy: "signed" }, meta, "GroveUpload_1234567890");
  const prefix = output.prefix.toString("utf8");
  assert.ok(prefix.indexOf('name="key"') < prefix.indexOf('name="file"'));
  assert.match(prefix, /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
  assert.equal(output.contentLength, output.prefix.length + 123 + output.suffix.length);
  assert.throws(() => multipartEnvelope({ bad: "line\r\nbreak" }, meta, "GroveUpload_1234567890"), CourseUploadError);
});

test("upload route, service, UI and MCP keep auth, ownership, streaming and approval gates wired", () => {
  const route = readFileSync(new URL("../app/api/canvas/courses/[courseId]/files/upload/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/courses/upload.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../components/ui/course-file-upload.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../components/ui/course-workspace.tsx", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../lib/mcp/course-upload.ts", import.meta.url), "utf8");
  const executors = readFileSync(new URL("../lib/mcp/executors.ts", import.meta.url), "utf8");
  const mcpRoute = readFileSync(new URL("../app/mcp/route.ts", import.meta.url), "utf8");
  assert.match(route, /await auth\(\)/); assert.match(route, /ensureUserForClerk\(session\.userId\)/); assert.match(route, /x-grove-csrf/);
  assert.match(route, /request\.body\.getReader\(\)/); assert.doesNotMatch(route, /formData\(/);
  assert.match(service, /c\.owner_id=\$\{ctx\.ownerId\}/); assert.match(service, /course_folders where owner_id=\$\{ctx\.ownerId\}/);
  assert.match(service, /hosted_browser_sessions[\s\S]*owner_id=\$\{ctx\.ownerId\}[\s\S]*canvas_account_id/);
  assert.match(service, /on conflict\(course_id,canvas_file_id\)/); assert.match(service, /kind,scope,dedupe_key/);
  assert.match(ui, /body: file/); assert.match(ui, /Upload to Canvas/); assert.match(workspace, /CourseFileUpload/);
  assert.match(mcp, /server\.registerTool\("upload_course_document"/); assert.match(mcp, /stageAction\(/); assert.match(mcp, /512 KiB/);
  assert.match(executors, /upload_course_document: executeCourseUploadAction/); assert.match(mcpRoute, /registerCourseUploadTool/);
});
