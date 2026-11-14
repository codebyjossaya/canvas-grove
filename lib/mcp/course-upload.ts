import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTenantSql } from "@/lib/db";
import { CourseUploadError, decodeBase64Document, MCP_UPLOAD_MAX_BASE64_CHARS, MCP_UPLOAD_MAX_BYTES, parseCourseUploadMeta } from "@/lib/courses/upload-contracts";
import { uploadCourseDocument } from "@/lib/courses/upload";
import { canPropose } from "./categories";
import { StageError, stageAction, type ActionRow, type ExecResult, type Executor, type StageOutcome } from "./actions";
import type { BearerAuth } from "./store";

const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false } as const;
const IDEM = z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/).optional().describe("Optional key; repeating it returns the same staged action");
export const uploadCourseDocumentArgs = {
  course: z.string().min(1).max(64).describe("Grove course id from list_courses (preferred), or its Canvas course id when unambiguous"),
  folderId: z.string().regex(/^\d{1,20}$/).optional().describe("Canvas folder id from list_files; omit for the course Files root"),
  filename: z.string().min(1).max(200).describe("Document filename including an allowed extension"),
  contentType: z.string().min(1).max(160).describe("Exact MIME type matching the filename"),
  contentBase64: z.string().min(4).max(MCP_UPLOAD_MAX_BASE64_CHARS).regex(/^[A-Za-z0-9+/]*={0,2}$/).describe("Standard base64 document bytes, at most 512 KiB; host filesystem paths are never accepted"),
  idempotencyKey: IDEM,
};

const ok = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const fail = (code: string, message: string): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify({ code, message }) }], structuredContent: { code, message }, isError: true });
const stageResult = (outcome: StageOutcome) => ({ actionId: outcome.action.id, status: outcome.action.status, preview: { title: outcome.action.title, summary: outcome.action.summary, ...outcome.action.preview }, expiresAt: outcome.action.expiresAt, replay: outcome.replay,
  ...(outcome.action.status === "awaiting_approval" ? { next: "Ask the user to approve this in Canvas Grove (Approvals), then check it with get_action." } : {}) });

async function* oneChunk(bytes: Uint8Array) { yield bytes; }

export const executeCourseUploadAction: Executor = async (ctx, action: ActionRow): Promise<ExecResult> => {
  try {
    const bytes = decodeBase64Document(String(action.args.contentBase64 ?? ""));
    const meta = parseCourseUploadMeta({ filename: action.args.filename, contentType: action.args.contentType, size: action.args.size, folderId: action.args.folderId }, MCP_UPLOAD_MAX_BYTES);
    if (bytes.length !== meta.size) throw new CourseUploadError("FILE_SIZE_MISMATCH", "The approved document no longer matches its preview.");
    const receipt = await uploadCourseDocument(ctx, String(action.args.courseId ?? ""), meta, oneChunk(bytes), `mcp-upload:${action.id}`);
    return { ok: true, message: `${receipt.displayName} was uploaded to Canvas Files.`, data: receipt };
  } catch (error) {
    if (error instanceof CourseUploadError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
};

export async function stageCourseUpload(auth: BearerAuth, args: z.infer<z.ZodObject<typeof uploadCourseDocumentArgs>>, executor: Executor) {
  const bytes = decodeBase64Document(args.contentBase64);
  const meta = parseCourseUploadMeta({ filename: args.filename, contentType: args.contentType, size: bytes.length, folderId: args.folderId }, MCP_UPLOAD_MAX_BYTES);
  const courses = await withTenantSql(auth.ctx.ownerId, (tx) => tx<{ id: string; canvas_course_id: string; name: string }[]>`select id,canvas_course_id,name from courses
    where owner_id=${auth.ctx.ownerId} and deleted_at is null and (id::text=${args.course.toLowerCase()} or canvas_course_id=${args.course}) order by favorite desc,name limit 2`);
  if (!courses.length) throw new CourseUploadError("COURSE_NOT_FOUND", "No such course. Use list_courses first.", 404);
  if (courses.length > 1 && !courses.some(course => course.id === args.course.toLowerCase())) throw new CourseUploadError("AMBIGUOUS_COURSE", "That Canvas course id exists at more than one institution. Use Grove's course id from list_courses.");
  const course = courses.find(item => item.id === args.course.toLowerCase()) ?? courses[0];
  let folderName = "Course Files (root)";
  if (meta.folderId) {
    const [folder] = await withTenantSql(auth.ctx.ownerId, (tx) => tx<{ name: string; full_name: string | null }[]>`select name,full_name from course_folders where owner_id=${auth.ctx.ownerId} and course_id=${course.id} and canvas_folder_id=${meta.folderId} and deleted_at is null limit 1`);
    if (!folder) throw new CourseUploadError("FOLDER_NOT_FOUND", "That folder is not part of this course.", 404);
    folderName = folder.full_name ?? folder.name;
  }
  const preview = { title: `Upload “${meta.filename}”`, summary: `${auth.clientName} wants to add a document to Canvas Files.`, lines: [
    { label: "Course", value: course.name }, { label: "Folder", value: folderName }, { label: "Document", value: meta.filename },
    { label: "Type", value: meta.contentType }, { label: "Size", value: `${(meta.size / 1024).toFixed(1)} KiB` },
  ], warning: "This creates a file in Canvas. It does not submit an assignment." };
  return stageAction(auth, { tool: "upload_course_document", args: { courseId: course.id, folderId: meta.folderId, filename: meta.filename, contentType: meta.contentType, size: meta.size, contentBase64: args.contentBase64 }, preview, idempotencyKey: args.idempotencyKey }, executor);
}

export function registerCourseUploadTool(server: McpServer, auth: BearerAuth, executor: Executor) {
  if (!canPropose(auth.scopes)) return;
  server.registerTool("upload_course_document", {
    title: "Upload course document",
    description: "Propose uploading a small document to a course's Canvas Files. Provide bounded base64 bytes (maximum 512 KiB), never a host path. Grove shows the course, folder, name, type, and size for explicit approval before any bytes reach Canvas. This does not submit an assignment.",
    inputSchema: uploadCourseDocumentArgs, annotations: WRITE,
  }, async (args): Promise<CallToolResult> => {
    const started = Date.now(); let status = "ok";
    try { return ok(stageResult(await stageCourseUpload(auth, args, executor))); }
    catch (error) {
      if (error instanceof CourseUploadError || error instanceof StageError) { status = error.code; return fail(error.code, error.message); }
      status = "error"; return fail("TOOL_FAILED", "Grove could not stage this upload right now.");
    } finally { console.info(JSON.stringify({ event: "mcp_tool", tool: "upload_course_document", ownerId: auth.ctx.ownerId, status, ms: Date.now() - started })); }
  });
}
