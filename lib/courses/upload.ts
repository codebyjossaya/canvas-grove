import "server-only";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { withTenantSql } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { executeCanvasApiForSession, hostedSessionStore, type HostedSession } from "@/lib/bridge/hosted-browser";
import { beginHostedOperation, finishHostedOperation } from "@/lib/bridge/postgres-operations";
import { publicOnlyLookup, readBounded } from "@/lib/canvas/session-client";
import { CourseUploadError, multipartEnvelope, nextCanvasUploadRedirect, parseCourseUploadMeta, validateCanvasUploadUrl, type CourseUploadMeta } from "./upload-contracts";

type Target = { id: string; name: string; canvas_course_id: string; canvas_account_id: string; canvas_base_url: string };
type StorageResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };
type Source = AsyncIterable<Uint8Array>;
export type CourseUploadReceipt = { uploaded: true; replay: boolean; groveFileId: string; canvasFileId: string; filename: string; displayName: string; contentType: string; size: number; folderId: string | null; downloadPath: string; canvasUrl: string; warnings: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown) => typeof value === "string" && value ? value : value == null ? null : String(value);
const integer = (value: unknown) => Number.isSafeInteger(Number(value)) ? Number(value) : null;
const header = (headers: IncomingHttpHeaders, name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };

async function targetFor(ctx: AuthContext, courseId: string, folderId: string | null): Promise<{ course: Target; session: HostedSession }> {
  if (!UUID.test(courseId)) throw new CourseUploadError("COURSE_NOT_FOUND", "Course not found.", 404);
  const [course] = await withTenantSql(ctx.ownerId, (tx) => tx<Target[]>`select c.id,c.name,c.canvas_course_id,c.canvas_account_id,ca.canvas_base_url
    from courses c join canvas_accounts ca on ca.owner_id=c.owner_id and ca.id=c.canvas_account_id
    where c.owner_id=${ctx.ownerId} and c.id=${courseId} and c.deleted_at is null limit 1`);
  if (!course) throw new CourseUploadError("COURSE_NOT_FOUND", "Course not found.", 404);
  if (folderId) {
    const [folder] = await withTenantSql(ctx.ownerId, (tx) => tx`select 1 from course_folders where owner_id=${ctx.ownerId} and course_id=${course.id} and canvas_folder_id=${folderId} and deleted_at is null limit 1`);
    if (!folder) throw new CourseUploadError("FOLDER_NOT_FOUND", "That folder is not part of this course.", 404);
  }
  const [linked] = await withTenantSql(ctx.ownerId, (tx) => tx<{ id: string }[]>`select id from hosted_browser_sessions
    where owner_id=${ctx.ownerId} and canvas_account_id=${course.canvas_account_id} and status='active' and revoked_at is null order by updated_at desc limit 1`);
  const session = linked ? await hostedSessionStore.getForOwner(linked.id, ctx.clerkUserId) : null;
  if (!session || session.state !== "active" || new URL(session.canvasOrigin).origin !== new URL(course.canvas_base_url).origin) {
    throw new CourseUploadError("CANVAS_AUTH_EXPIRED", "Reconnect this Canvas account before uploading.", 401);
  }
  return { course, session };
}

async function* multipartBody(source: Source, meta: CourseUploadMeta, fields: Record<string, string>, boundary: string) {
  const envelope = multipartEnvelope(fields, meta, boundary);
  yield envelope.prefix;
  let count = 0;
  for await (const chunk of source) {
    count += chunk.byteLength;
    if (count > meta.size) throw new CourseUploadError("FILE_SIZE_MISMATCH", "The upload contained more bytes than declared.", 400);
    yield chunk;
  }
  if (count !== meta.size) throw new CourseUploadError("FILE_SIZE_MISMATCH", "The upload ended before the declared file size.", 400);
  yield envelope.suffix;
}

function transport(url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: Source): Promise<StorageResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method, headers, lookup: publicOnlyLookup, signal: AbortSignal.timeout(120_000) }, (response) => {
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > 1024 * 1024) { response.destroy(); reject(new CourseUploadError("UPLOAD_RESPONSE_TOO_LARGE", "Canvas returned an oversized upload response.", 502)); return; }
      readBounded(response, 1024 * 1024).then((responseBody) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: responseBody }), reject);
    });
    request.on("error", reject);
    void (async () => {
      try {
        if (body) for await (const chunk of body) if (!request.write(chunk)) await once(request, "drain");
        request.end();
      } catch (error) { request.destroy(error instanceof Error ? error : new Error("Upload stream failed")); reject(error); }
    })();
  });
}

function parseStorageFile(response: StorageResponse): Record<string, unknown> {
  const type = header(response.headers, "content-type") ?? "";
  if (response.status < 200 || response.status >= 300) throw new CourseUploadError("CANVAS_UPLOAD_REJECTED", `Canvas file storage rejected the upload (HTTP ${response.status}).`, response.status === 413 ? 413 : 502);
  if (!/json/i.test(type)) throw new CourseUploadError("CANVAS_UPLOAD_UNCONFIRMED", "Canvas accepted the bytes but did not return a file receipt. Check Canvas before retrying.", 502);
  try { const value = JSON.parse(response.body.toString("utf8").replace(/^while\(1\);/, "")); if (record(value)) return value; }
  catch { /* handled below */ }
  throw new CourseUploadError("CANVAS_UPLOAD_UNCONFIRMED", "Canvas returned an unreadable file receipt. Check Canvas before retrying.", 502);
}

async function uploadStorage(uploadUrl: string, fields: Record<string, string>, source: Source, meta: CourseUploadMeta, canvasOrigin: string) {
  let url = validateCanvasUploadUrl(uploadUrl, canvasOrigin);
  const boundary = `GroveUpload_${randomBytes(18).toString("base64url")}`;
  const envelope = multipartEnvelope(fields, meta, boundary);
  let response = await transport(url, "POST", { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(envelope.contentLength), accept: "application/json", "user-agent": "CanvasGrove/1.0 file-upload" }, multipartBody(source, meta, fields, boundary));
  for (let redirects = 0; response.status >= 300 && response.status < 400; redirects += 1) {
    if (redirects >= 3) throw new CourseUploadError("TOO_MANY_UPLOAD_REDIRECTS", "Canvas returned too many upload redirects.", 502);
    url = nextCanvasUploadRedirect(response.status, header(response.headers, "location"), url, canvasOrigin)!;
    response = await transport(url, "GET", { accept: "application/json", "user-agent": "CanvasGrove/1.0 file-upload" });
  }
  return parseStorageFile(response);
}

function handshake(value: unknown): { uploadUrl: string; fields: Record<string, string> } {
  if (!record(value) || typeof value.upload_url !== "string" || !record(value.upload_params)) throw new CourseUploadError("CANVAS_UPLOAD_HANDSHAKE_INVALID", "Canvas did not return a valid upload destination.", 502);
  const fields: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.upload_params)) {
    if (typeof item !== "string" && typeof item !== "number") throw new CourseUploadError("INVALID_UPLOAD_PARAMETERS", "Canvas returned invalid upload parameters.", 502);
    fields[key] = String(item);
  }
  return { uploadUrl: value.upload_url, fields };
}

async function persist(ctx: AuthContext, course: Target, session: HostedSession, value: Record<string, unknown>, meta: CourseUploadMeta): Promise<CourseUploadReceipt> {
  const canvasFileId = text(value.id);
  if (!canvasFileId || !/^\d{1,20}$/.test(canvasFileId)) throw new CourseUploadError("CANVAS_UPLOAD_UNCONFIRMED", "Canvas did not identify the uploaded file. Check Canvas before retrying.", 502);
  const filename = text(value.filename) ?? meta.filename;
  const displayName = text(value.display_name) ?? filename;
  const contentType = text(value["content-type"]) ?? text(value.content_type) ?? meta.contentType;
  const size = integer(value.size) ?? meta.size;
  const folderId = text(value.folder_id) ?? meta.folderId;
  const [saved] = await withTenantSql(ctx.ownerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`insert into course_files(owner_id,course_id,canvas_file_id,canvas_folder_id,display_name,filename,content_type,size,locked,hidden,source_created_at,source_updated_at,synced_at,deleted_at,updated_at)
      values(${ctx.ownerId},${course.id},${canvasFileId},${folderId},${displayName},${filename},${contentType},${size},false,false,now(),now(),now(),null,now())
      on conflict(course_id,canvas_file_id) do update set canvas_folder_id=excluded.canvas_folder_id,display_name=excluded.display_name,filename=excluded.filename,content_type=excluded.content_type,size=excluded.size,synced_at=now(),deleted_at=null,updated_at=now() returning id`;
    await tx`insert into sync_jobs(owner_id,canvas_account_id,hosted_session_id,kind,scope,dedupe_key,status,priority,max_attempts,run_after)
      values(${ctx.ownerId},${course.canvas_account_id},${session.id},'files',${tx.json({ courseId: course.id, reason: "file_uploaded" })},${`file-upload-refresh:${course.id}`},'queued',150,5,now()) on conflict do nothing`;
    return rows;
  });
  if (!saved) throw new CourseUploadError("UPLOAD_CACHE_FAILED", "Canvas stored the file, but Grove could not refresh it. Check Canvas before retrying.", 502);
  return { uploaded: true, replay: false, groveFileId: saved.id, canvasFileId, filename, displayName, contentType, size, folderId,
    downloadPath: `/api/canvas/courses/${course.id}/files/${saved.id}/download`, canvasUrl: `${new URL(course.canvas_base_url).origin}/courses/${course.canvas_course_id}/files/${canvasFileId}`, warnings: [] };
}

function failure(status: number, authRequired: boolean): never {
  if (authRequired || status === 401) throw new CourseUploadError("CANVAS_AUTH_EXPIRED", "Canvas sign-in has expired. Reconnect Canvas, then try again.", 401);
  if (status === 403) throw new CourseUploadError("UPLOAD_NOT_ALLOWED", "Canvas does not allow file uploads to this course or folder.", 403);
  if (status === 413) throw new CourseUploadError("FILE_TOO_LARGE", "Canvas rejected the document as too large.", 413);
  if (status === 429) throw new CourseUploadError("CANVAS_RATE_LIMITED", "Canvas is rate limiting uploads. Try again later.", 429);
  throw new CourseUploadError("CANVAS_UPLOAD_FAILED", `Canvas could not start the upload (HTTP ${status}).`, 502);
}

export async function uploadCourseDocument(ctx: AuthContext, courseId: string, rawMeta: CourseUploadMeta, source: Source, idempotencyKey: string): Promise<CourseUploadReceipt> {
  const meta = parseCourseUploadMeta(rawMeta);
  const { course, session } = await targetFor(ctx, courseId, meta.folderId);
  const operationKey = `course-file:${course.canvas_account_id}:${idempotencyKey}`;
  const request = { method: "POST" as const, path: `/api/v1/courses/${course.canvas_course_id}/files`, body: { name: meta.filename, size: meta.size, content_type: meta.contentType, parent_folder_id: meta.folderId, on_duplicate: "rename" } };
  let started: Awaited<ReturnType<typeof beginHostedOperation>>;
  try { started = await beginHostedOperation(ctx.clerkUserId, operationKey, request); }
  catch (error) { throw new CourseUploadError("IDEMPOTENCY_CONFLICT", error instanceof Error && error.message.includes("different request") ? "That retry key was already used for a different document." : "An upload with that retry key is already in progress.", 409); }
  if ("prior" in started) {
    if (started.prior.ok && record(started.prior.data)) return { ...(started.prior.data as CourseUploadReceipt), replay: true };
    throw new CourseUploadError(started.prior.error ?? "CANVAS_UPLOAD_FAILED", "This upload attempt already finished unsuccessfully. Review Canvas before using a new retry key.", started.prior.status || 502);
  }
  try {
    const initial = await executeCanvasApiForSession(session, ctx.clerkUserId, request);
    if (!initial.ok) failure(initial.status, initial.authRequired);
    const step = handshake(initial.data);
    const uploaded = await uploadStorage(step.uploadUrl, step.fields, source, meta, course.canvas_base_url);
    let receipt: CourseUploadReceipt;
    try { receipt = await persist(ctx, course, session, uploaded, meta); }
    catch (error) {
      if (error instanceof CourseUploadError) throw error;
      throw new CourseUploadError("UPLOAD_CACHE_FAILED", "Canvas stored the file, but Grove could not refresh it. Check Canvas before retrying.", 502);
    }
    await finishHostedOperation(ctx.clerkUserId, operationKey, started.operationId, { ok: true, status: 201, authRequired: false, data: receipt });
    return receipt;
  } catch (error) {
    const failureError = error instanceof CourseUploadError ? error : new CourseUploadError("CANVAS_UPLOAD_STATUS_UNKNOWN", "Grove could not confirm the upload. Check Canvas before retrying.", 502);
    await finishHostedOperation(ctx.clerkUserId, operationKey, started.operationId, { ok: false, status: failureError.status, authRequired: failureError.status === 401, error: failureError.code }).catch(() => undefined);
    throw failureError;
  }
}
