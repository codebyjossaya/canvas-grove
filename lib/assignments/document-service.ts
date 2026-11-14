import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { withTenantSql } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { executeCanvasApiForSession, hostedSessionStore, type HostedSession } from "@/lib/bridge/hosted-browser";
import { beginHostedOperation, finishHostedOperation } from "@/lib/bridge/postgres-operations";
import { CourseUploadError, type CourseUploadMeta } from "@/lib/courses/upload-contracts";
import { parseCanvasUploadHandshake, uploadCanvasStorage, type UploadSource } from "@/lib/courses/upload";
import { AssignmentSubmissionInputError, assertLiveAssignmentAllows, assignmentPreflightPath, isRecord } from "./contracts";
import { submitAssignment } from "./service";
import { assignmentDocumentHandshakeRequest, assignmentDocumentOperationRequest, parseAssignmentDocumentMeta, type AssignmentDocumentMeta } from "./document-contracts";

type Target = { id: string; title: string; course_name: string; canvas_assignment_id: string; canvas_course_id: string; canvas_account_id: string; canvas_base_url: string };
export type AssignmentDocumentPreview = { assignmentId: string; assignmentTitle: string; courseName: string; previousAttempt: number; nextAttempt: number; allowedAttempts: number | null };
export type AssignmentDocumentReceipt = AssignmentDocumentPreview & { submitted: true; replay: boolean; canvasFileId: string; filename: string; contentType: string; size: number; canvasSubmissionId: string | null; attempt: number | null; state: string | null; submittedAt: string | null; warnings: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function targetFor(ctx: AuthContext, assignmentId: string): Promise<Target> {
  if (!UUID.test(assignmentId)) throw new AssignmentSubmissionInputError("ASSIGNMENT_NOT_FOUND", "Assignment not found.", 404);
  const [row] = await withTenantSql(ctx.ownerId, (tx) => tx<Target[]>`select a.id,a.name as title,c.name as course_name,a.canvas_assignment_id,c.canvas_course_id,c.canvas_account_id,ca.canvas_base_url
    from assignments a join courses c on c.owner_id=a.owner_id and c.id=a.course_id and c.deleted_at is null
    join canvas_accounts ca on ca.owner_id=c.owner_id and ca.id=c.canvas_account_id
    where a.owner_id=${ctx.ownerId} and a.id=${assignmentId} and a.deleted_at is null limit 1`);
  if (!row) throw new AssignmentSubmissionInputError("ASSIGNMENT_NOT_FOUND", "Assignment not found.", 404);
  return row;
}

async function sessionFor(ctx: AuthContext, target: Target): Promise<HostedSession> {
  const [linked] = await withTenantSql(ctx.ownerId, (tx) => tx<{ id: string }[]>`select id from hosted_browser_sessions
    where owner_id=${ctx.ownerId} and canvas_account_id=${target.canvas_account_id} and status='active' and revoked_at is null order by updated_at desc limit 1`);
  const session = linked ? await hostedSessionStore.getForOwner(linked.id, ctx.clerkUserId) : null;
  if (!session || session.state !== "active" || new URL(session.canvasOrigin).origin !== new URL(target.canvas_base_url).origin) {
    throw new AssignmentSubmissionInputError("CANVAS_AUTH_EXPIRED", "Reconnect this Canvas account before submitting.", 401);
  }
  return session;
}

async function livePreview(ctx: AuthContext, target: Target, session: HostedSession): Promise<AssignmentDocumentPreview> {
  const check = await executeCanvasApiForSession(session, ctx.clerkUserId, { method: "GET", path: assignmentPreflightPath(target.canvas_course_id, target.canvas_assignment_id) });
  if (!check.ok) {
    if (check.authRequired || check.status === 401) throw new AssignmentSubmissionInputError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas, then try again.", 401);
    throw new AssignmentSubmissionInputError("ASSIGNMENT_CHECK_FAILED", `Canvas could not verify this assignment (HTTP ${check.status}).`, 502);
  }
  const eligibility = assertLiveAssignmentAllows(check.data, "online_upload");
  return { assignmentId: target.id, assignmentTitle: target.title, courseName: target.course_name, previousAttempt: eligibility.previousAttempt, nextAttempt: eligibility.previousAttempt + 1, allowedAttempts: eligibility.allowedAttempts };
}

export async function getAssignmentDocumentPreview(ctx: AuthContext, assignmentId: string): Promise<AssignmentDocumentPreview> {
  const target = await targetFor(ctx, assignmentId);
  return livePreview(ctx, target, await sessionFor(ctx, target));
}

const canvasFileId = (value: unknown) => {
  if (!isRecord(value) || !/^\d{1,20}$/.test(String(value.id ?? ""))) throw new CourseUploadError("CANVAS_UPLOAD_UNCONFIRMED", "Canvas stored the bytes but did not identify the assignment file. Check Canvas before retrying.", 502);
  return String(value.id);
};

/** Hashes the actual streamed bytes. A mismatch aborts before the multipart closing boundary. */
async function* verifiedSource(source: UploadSource, expectedHex: string): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  for await (const chunk of source) { hash.update(chunk); yield chunk; }
  const actual = hash.digest();
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new CourseUploadError("FILE_DIGEST_MISMATCH_STATUS_UNKNOWN", "The streamed bytes did not match the selected document. Grove stopped before assignment submission, but Canvas storage received incomplete upload bytes; check Canvas before retrying.", 502);
  }
}

export async function submitAssignmentDocument(ctx: AuthContext, assignmentId: string, rawMeta: AssignmentDocumentMeta, source: UploadSource, idempotencyKey: string): Promise<AssignmentDocumentReceipt> {
  const meta = parseAssignmentDocumentMeta(rawMeta);
  const target = await targetFor(ctx, assignmentId);
  const session = await sessionFor(ctx, target);
  const operationKey = `assignment-document:${target.canvas_account_id}:${idempotencyKey}`;
  const operationRequest = assignmentDocumentOperationRequest(target.canvas_course_id, target.canvas_assignment_id, meta);
  let started: Awaited<ReturnType<typeof beginHostedOperation>>;
  try { started = await beginHostedOperation(ctx.clerkUserId, operationKey, operationRequest); }
  catch (error) { throw new AssignmentSubmissionInputError("IDEMPOTENCY_CONFLICT", error instanceof Error && error.message.includes("different request") ? "That retry key belongs to a different document." : "This document submission is already in progress. Check Canvas before retrying.", 409); }
  if ("prior" in started) {
    if (started.prior.ok && isRecord(started.prior.data)) return { ...(started.prior.data as AssignmentDocumentReceipt), replay: true };
    throw new AssignmentSubmissionInputError(started.prior.error ?? "DOCUMENT_SUBMISSION_FAILED", "This document submission already finished unsuccessfully. Check Canvas before using a new retry key.", started.prior.status || 502);
  }
  let fileStored = false;
  try {
    const preview = await livePreview(ctx, target, session);
    const request = assignmentDocumentHandshakeRequest(target.canvas_course_id, target.canvas_assignment_id, meta);
    const initial = await executeCanvasApiForSession(session, ctx.clerkUserId, request);
    if (!initial.ok) {
      if (initial.authRequired || initial.status === 401) throw new AssignmentSubmissionInputError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas, then try again.", 401);
      if (initial.status === 403) throw new AssignmentSubmissionInputError("UPLOAD_NOT_ALLOWED", "Canvas does not allow a file upload for this assignment.", 403);
      if (initial.status === 413) throw new AssignmentSubmissionInputError("FILE_TOO_LARGE", "Canvas rejected the document as too large.", 413);
      throw new AssignmentSubmissionInputError("CANVAS_UPLOAD_FAILED", `Canvas could not start the assignment upload (HTTP ${initial.status}).`, 502);
    }
    const step = parseCanvasUploadHandshake(initial.data);
    const uploaded = await uploadCanvasStorage(step.uploadUrl, step.fields, verifiedSource(source, meta.sha256), meta as CourseUploadMeta, target.canvas_base_url);
    const fileId = canvasFileId(uploaded);
    fileStored = true;
    // The shared submit path performs a second fresh Canvas eligibility check after the upload.
    const submission = await submitAssignment(ctx, assignmentId, { type: "online_upload", canvasFileIds: [fileId] }, `document-submit:${idempotencyKey}`);
    const receipt: AssignmentDocumentReceipt = { ...preview, submitted: true, replay: false, canvasFileId: fileId, filename: meta.filename, contentType: meta.contentType, size: meta.size, canvasSubmissionId: submission.canvasSubmissionId, attempt: submission.attempt, state: submission.state, submittedAt: submission.submittedAt, warnings: submission.warnings };
    await finishHostedOperation(ctx.clerkUserId, operationKey, started.operationId, { ok: true, status: 201, authRequired: false, data: receipt });
    return receipt;
  } catch (error) {
    const original = error instanceof AssignmentSubmissionInputError || error instanceof CourseUploadError ? error : new AssignmentSubmissionInputError("DOCUMENT_SUBMISSION_STATUS_UNKNOWN", "Grove could not confirm whether Canvas received this document submission. Check Canvas before retrying.", 502);
    const failure = fileStored
      ? new AssignmentSubmissionInputError(original.code, `Canvas stored the document, but Grove did not confirm it as an assignment submission. ${original.message} Check the assignment in Canvas before trying again.`, original.status)
      : original;
    await finishHostedOperation(ctx.clerkUserId, operationKey, started.operationId, { ok: false, status: failure.status, authRequired: failure.status === 401, error: failure.code }).catch(() => undefined);
    throw failure;
  }
}
