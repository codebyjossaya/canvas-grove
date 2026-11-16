import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AssignmentSubmissionInputError } from "@/lib/assignments/contracts";
import { getAssignmentDocumentPreview, submitAssignmentDocument } from "@/lib/assignments/document-service";
import { parseAssignmentDocumentMeta } from "@/lib/assignments/document-contracts";
import { CourseUploadError, decodeBase64Document, MCP_UPLOAD_MAX_BASE64_CHARS, MCP_UPLOAD_MAX_BYTES } from "@/lib/courses/upload-contracts";
import { canPropose } from "./categories";
import { StageError, stageAction, type ActionRow, type ExecResult, type Executor, type StageOutcome } from "./actions";
import type { BearerAuth } from "./store";
import { ScopeDisabledError } from "@/lib/scopes/settings";
import { assertToolScope } from "@/lib/scopes/store";

const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false } as const;
export const submitAssignmentDocumentArgs = {
  assignmentId: z.string().uuid().describe("Grove assignment id from list_assignments or get_assignment"),
  filename: z.string().min(1).max(200).describe("Document filename including an allowed extension"),
  contentType: z.string().min(1).max(160).describe("Exact MIME type matching the filename"),
  contentBase64: z.string().min(4).max(MCP_UPLOAD_MAX_BASE64_CHARS).regex(/^[A-Za-z0-9+/]*={0,2}$/).describe("Standard base64 document bytes, at most 512 KiB; host paths are never accepted"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/).optional().describe("Optional key; repeating it returns the same staged action"),
};

const ok = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const fail = (code: string, message: string): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify({ code, message }) }], structuredContent: { code, message }, isError: true });
const staged = (outcome: StageOutcome) => ({ actionId: outcome.action.id, status: outcome.action.status, preview: { title: outcome.action.title, summary: outcome.action.summary, ...outcome.action.preview }, expiresAt: outcome.action.expiresAt, replay: outcome.replay, next: "Ask the user to approve this in Canvas Grove (Approvals), then check it with get_action." });
async function* oneChunk(bytes: Uint8Array) { yield bytes; }

export const executeAssignmentDocumentAction: Executor = async (ctx, action: ActionRow): Promise<ExecResult> => {
  try {
    const bytes = decodeBase64Document(String(action.args.contentBase64 ?? ""));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const meta = parseAssignmentDocumentMeta({ filename: action.args.filename, contentType: action.args.contentType, size: action.args.size, sha256 }, MCP_UPLOAD_MAX_BYTES);
    if (bytes.length !== meta.size || sha256 !== action.args.sha256) throw new CourseUploadError("DOCUMENT_CHANGED", "The approved document no longer matches its preview.", 409);
    const receipt = await submitAssignmentDocument(ctx, String(action.args.assignmentId ?? ""), meta, oneChunk(bytes), `mcp-assignment-document:${action.id}`);
    return { ok: true, message: `${receipt.filename} was submitted to ${receipt.assignmentTitle}${receipt.attempt ? ` as attempt ${receipt.attempt}` : ""}.`, data: receipt };
  } catch (error) {
    if (error instanceof CourseUploadError || error instanceof AssignmentSubmissionInputError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
};

export async function stageAssignmentDocument(auth: BearerAuth, args: z.infer<z.ZodObject<typeof submitAssignmentDocumentArgs>>, executor: Executor) {
  const bytes = decodeBase64Document(args.contentBase64);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const meta = parseAssignmentDocumentMeta({ filename: args.filename, contentType: args.contentType, size: bytes.length, sha256 }, MCP_UPLOAD_MAX_BYTES);
  const preview = await getAssignmentDocumentPreview(auth.ctx, args.assignmentId);
  const outcome = await stageAction(auth, { tool: "submit_assignment_document", args: { assignmentId: args.assignmentId, filename: meta.filename, contentType: meta.contentType, size: meta.size, sha256, contentBase64: args.contentBase64 }, preview: {
    title: `Submit “${meta.filename}”`, summary: `${auth.clientName} wants to turn in a document to Canvas.`, lines: [
      { label: "Course", value: preview.courseName }, { label: "Assignment", value: preview.assignmentTitle }, { label: "Document", value: meta.filename },
      { label: "Type", value: meta.contentType }, { label: "Size", value: `${(meta.size / 1024).toFixed(1)} KiB` },
      { label: "Attempt", value: `${preview.nextAttempt}${preview.allowedAttempts != null ? ` of ${preview.allowedAttempts}` : ""}` },
    ], warning: "Approval uploads this file and submits it to the exact assignment. It may consume an attempt and is never covered by auto mode.",
  }, idempotencyKey: args.idempotencyKey }, executor);
  if (outcome.action.status !== "awaiting_approval" && !outcome.replay) throw new StageError("APPROVAL_REQUIRED", "Assignment documents must wait for explicit approval. Nothing was submitted.");
  return outcome;
}

export function registerAssignmentDocumentTool(server: McpServer, auth: BearerAuth, executor: Executor) {
  if (!canPropose(auth.scopes)) return;
  server.registerTool("submit_assignment_document", {
    title: "Submit assignment document",
    description: "Propose uploading and submitting a small document to one exact Canvas assignment. Use the Grove assignment id and bounded base64 bytes (maximum 512 KiB), never a host path. Grove previews course, assignment, file, size, and attempt; it always requires explicit approval and re-checks Canvas at execution.",
    inputSchema: submitAssignmentDocumentArgs, annotations: WRITE,
  }, async (args): Promise<CallToolResult> => {
    const startedAt = Date.now(); let status = "ok";
    try { await assertToolScope(auth.ctx.ownerId, "submit_assignment_document"); return ok(staged(await stageAssignmentDocument(auth, args, executor))); }
    catch (error) {
      if (error instanceof ScopeDisabledError || error instanceof CourseUploadError || error instanceof AssignmentSubmissionInputError || error instanceof StageError) { status = error.code; return fail(error.code, error.message); }
      status = "error"; return fail("TOOL_FAILED", "Grove could not stage this assignment document right now.");
    } finally { console.info(JSON.stringify({ event: "mcp_tool", tool: "submit_assignment_document", ownerId: auth.ctx.ownerId, status, ms: Date.now() - startedAt })); }
  });
}
