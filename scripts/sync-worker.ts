import { createHash, createHmac, randomBytes } from "node:crypto";
import process from "node:process";
import postgres from "postgres";
import { backoffMs, deterministicJitterMs, isAssignmentEvent, QUIZ_ATTEMPT_RESYNC_SECONDS, QUIZ_DEADLINE_RESYNC_SECONDS, isQuizHot, syncPolicies, type SyncKind } from "../lib/sync/catalog";
import { executeCanvasSyncJob } from "../lib/sync/executor";
import type { EncryptedBrowserState, HostedBrowserProvider } from "../lib/bridge/hosted-browser";
import { SelfHostedChromiumProvider } from "../lib/bridge/providers/self-hosted";
import { toCanvasLoginPath, type CanvasLoginPath } from "../lib/canvas/institution";
import { BridgeError } from "../lib/bridge/errors";
import { monitorRepairAction } from "../lib/sync/monitor-repair";
import { restrictionReason, safeQuizHtml } from "../lib/quizzes/contracts";
import { completeAuthenticationTx, releaseLoginBrowser } from "../lib/bridge/complete-authentication";
import { CanvasSessionClient } from "../lib/canvas/session-client";
import { healthEventRow, keepaliveDue, keepaliveMinutes, nextKeepaliveKind, pageKeepaliveEnabled, type HealthKind } from "../lib/canvas/session-health";
import { insertHealthEvent, sqlEncryptedStateStore } from "../lib/canvas/session-store-sql";
import { browserLostRecoveryAction, recoveryOutcome, STRANDED_FAILURE_CODE } from "../lib/canvas/session-recovery";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl, { max: Number(process.env.SYNC_WORKER_CONCURRENCY ?? 4) + 2 });
const workerId = process.env.SYNC_WORKER_ID ?? `sync-${process.pid}-${randomBytes(4).toString("hex")}`;
const concurrency = Math.max(1, Number(process.env.SYNC_WORKER_CONCURRENCY ?? 4));
const leaseSeconds = 120;
const pollMs = Math.max(500, Number(process.env.SYNC_WORKER_POLL_MS ?? 3000));
const kinds = Object.keys(syncPolicies) as SyncKind[];
let stopping = false;
let nextReconcileAt = 0;
let nextSessionHealthAt = 0;
// Keepalive: canvas-lms slides `expire_after` per request (default 1 day,
// institution minimum 20 minutes), so 10 minutes keeps any configured timeout alive.
const KEEPALIVE_MINUTES = keepaliveMinutes(process.env.CANVAS_KEEPALIVE_MINUTES);
const PAGE_KEEPALIVE = pageKeepaliveEnabled(process.env.CANVAS_PAGE_KEEPALIVE);
// While a user is mid sign-in, re-check quickly so completion is noticed fast
// (the /confirm route is the primary fast path; this monitor is the backstop).
const INTERACTIVE_RECHECK_MS = 1500;
// Auth monitors run in their own slots: long sync jobs filling every worker slot
// must never delay completing a sign-in the user is waiting on.
const MONITOR_CONCURRENCY = 2;
let lastMonitorClaimAt = 0;
if ((process.env.HOSTED_BROWSER_PROVIDER || "self-hosted") !== "self-hosted") throw new Error("The durable auth monitor currently requires the self-hosted browser provider");
const hostedBrowserProvider: HostedBrowserProvider = new SelfHostedChromiumProvider();

type Job = { jobId: string; ownerId: string; canvasAccountId: string; hostedSessionId: string; canvasOrigin: string; kind: SyncKind; scope: unknown; attempt: number; leaseToken: string; leaseOwner: string };
type Monitor = { monitorId: string; attemptId: string; ownerId: string; hostedSessionId: string; providerSessionRef: string; canvasOrigin: string; institutionName: string; authHostRules: string[]; loginPath: CanvasLoginPath; deadlineAt: Date; leaseToken?: string };

type CanvasRecord = Record<string, unknown>;

function records(value: unknown): CanvasRecord[] {
  return Array.isArray(value) ? value.filter((item): item is CanvasRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
function object(value: unknown): CanvasRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as CanvasRecord : {}; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null; }
function dateValue(value: unknown): string | null { const valueText = textValue(value); return valueText && !Number.isNaN(Date.parse(valueText)) ? valueText : null; }
function numberValue(value: unknown): number | null { const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN; return Number.isFinite(result) ? result : null; }
function booleanValue(value: unknown): boolean { return value === true; }
function courseExternalId(item: CanvasRecord): string | null {
  const direct = textValue(item.course_id) ?? textValue(item.context_id);
  if (direct) return direct;
  const context = textValue(item.context_code);
  return context?.match(/^course_(.+)$/)?.[1] ?? null;
}

async function upsertCourse(tx: postgres.TransactionSql, job: Job, item: CanvasRecord, fallbackName?: string) {
  const canvasCourseId = textValue(item.id) ?? courseExternalId(item);
  if (!canvasCourseId) return null;
  const enrollment = records(item.enrollments)[0] ?? {};
  const term = object(item.term);
  const name = textValue(item.name) ?? textValue(item.context_name) ?? fallbackName ?? `Canvas course ${canvasCourseId}`;
  const hasFavorite = typeof item.is_favorite === "boolean";
  const rows = await tx<{ id: string }[]>`insert into courses(owner_id,canvas_account_id,canvas_course_id,name,course_code,term_name,workflow_state,start_at,end_at,current_score,current_grade,image_url,favorite,apply_assignment_group_weights,syllabus_body,syllabus_synced_at,source_updated_at,synced_at,deleted_at,source_payload,updated_at)
    values(${job.ownerId},${job.canvasAccountId},${canvasCourseId},${name},${textValue(item.course_code)},${textValue(term.name)},${textValue(item.workflow_state)},${dateValue(item.start_at)},${dateValue(item.end_at)},${numberValue(enrollment.computed_current_score) ?? numberValue(enrollment.current_score)},${textValue(enrollment.computed_current_grade) ?? textValue(enrollment.current_grade)},${textValue(item.image_download_url) ?? textValue(item.image_url)},${booleanValue(item.is_favorite)},${booleanValue(item.apply_assignment_group_weights)},${safeQuizHtml(item.syllabus_body)},${typeof item.syllabus_body === "string" ? new Date().toISOString() : null},${dateValue(item.updated_at)},now(),null,${tx.json(item)},now())
    on conflict(canvas_account_id,canvas_course_id) do update set name=case when excluded.name like 'Canvas course %' then courses.name else excluded.name end,
      course_code=coalesce(excluded.course_code,courses.course_code),term_name=coalesce(excluded.term_name,courses.term_name),workflow_state=coalesce(excluded.workflow_state,courses.workflow_state),start_at=coalesce(excluded.start_at,courses.start_at),end_at=coalesce(excluded.end_at,courses.end_at),current_score=coalesce(excluded.current_score,courses.current_score),current_grade=coalesce(excluded.current_grade,courses.current_grade),image_url=coalesce(excluded.image_url,courses.image_url),favorite=case when ${hasFavorite} then excluded.favorite else courses.favorite end,apply_assignment_group_weights=excluded.apply_assignment_group_weights,syllabus_body=coalesce(excluded.syllabus_body,courses.syllabus_body),syllabus_synced_at=coalesce(excluded.syllabus_synced_at,courses.syllabus_synced_at),source_updated_at=coalesce(excluded.source_updated_at,courses.source_updated_at),synced_at=now(),deleted_at=null,source_payload=excluded.source_payload,updated_at=now() returning id`;
  return rows[0]?.id ?? null;
}

async function ensureCourse(tx: postgres.TransactionSql, job: Job, item: CanvasRecord) {
  const externalId = courseExternalId(item);
  if (!externalId) return null;
  return upsertCourse(tx, job, { id: externalId, context_name: item.context_name }, textValue(item.context_name) ?? undefined);
}

async function persistCourseContent(tx: postgres.TransactionSql, job: Job, value: unknown) {
  const payload = object(value);
  for (const entry of records(payload.courses)) {
    const courseId = await upsertCourse(tx, job, object(entry.course));
    if (!courseId) continue;
    if (entry.complete === true) {
      await tx`update course_tabs set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
      await tx`update course_folders set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
      await tx`update course_files set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
      await tx`update course_modules set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
      await tx`update course_pages set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
      await tx`update assignment_groups set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
    }
    for (const tab of records(entry.tabs)) {
      const id = textValue(tab.id); if (!id) continue;
      await tx`insert into course_tabs(owner_id,course_id,canvas_tab_id,label,position,tab_type,hidden,external,html_url,synced_at,deleted_at,updated_at)
        values(${job.ownerId},${courseId},${id},${textValue(tab.label) ?? id},${numberValue(tab.position)},${textValue(tab.type)},${booleanValue(tab.hidden)},${booleanValue(tab.external)},${textValue(tab.html_url)},now(),null,now())
        on conflict(course_id,canvas_tab_id) do update set label=excluded.label,position=excluded.position,tab_type=excluded.tab_type,hidden=excluded.hidden,external=excluded.external,html_url=excluded.html_url,synced_at=now(),deleted_at=null,updated_at=now()`;
    }
    for (const folder of records(entry.folders)) {
      const id = textValue(folder.id); if (!id) continue;
      await tx`insert into course_folders(owner_id,course_id,canvas_folder_id,parent_canvas_folder_id,name,full_name,files_count,folders_count,locked,hidden,unlock_at,lock_at,synced_at,deleted_at,updated_at)
        values(${job.ownerId},${courseId},${id},${textValue(folder.parent_folder_id)},${textValue(folder.name) ?? "Folder"},${textValue(folder.full_name)},${numberValue(folder.files_count) ?? 0},${numberValue(folder.folders_count) ?? 0},${booleanValue(folder.locked)},${booleanValue(folder.hidden)},${dateValue(folder.unlock_at)},${dateValue(folder.lock_at)},now(),null,now())
        on conflict(course_id,canvas_folder_id) do update set parent_canvas_folder_id=excluded.parent_canvas_folder_id,name=excluded.name,full_name=excluded.full_name,files_count=excluded.files_count,folders_count=excluded.folders_count,locked=excluded.locked,hidden=excluded.hidden,unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,synced_at=now(),deleted_at=null,updated_at=now()`;
    }
    for (const file of records(entry.files)) {
      const id = textValue(file.id); if (!id) continue;
      await tx`insert into course_files(owner_id,course_id,canvas_file_id,canvas_folder_id,display_name,filename,content_type,size,locked,hidden,source_created_at,source_updated_at,synced_at,deleted_at,updated_at)
        values(${job.ownerId},${courseId},${id},${textValue(file.folder_id)},${textValue(file.display_name) ?? textValue(file.filename) ?? "File"},${textValue(file.filename)},${textValue(file["content-type"])},${numberValue(file.size)},${booleanValue(file.locked)},${booleanValue(file.hidden)},${dateValue(file.created_at)},${dateValue(file.updated_at)},now(),null,now())
        on conflict(course_id,canvas_file_id) do update set canvas_folder_id=excluded.canvas_folder_id,display_name=excluded.display_name,filename=excluded.filename,content_type=excluded.content_type,size=excluded.size,locked=excluded.locked,hidden=excluded.hidden,source_updated_at=excluded.source_updated_at,synced_at=now(),deleted_at=null,updated_at=now()`;
    }
    for (const courseModule of records(entry.modules)) {
      const id = textValue(courseModule.id); if (!id) continue;
      const moduleRows = await tx<{ id: string }[]>`insert into course_modules(owner_id,course_id,canvas_module_id,name,position,state,unlock_at,synced_at,deleted_at,updated_at)
        values(${job.ownerId},${courseId},${id},${textValue(courseModule.name) ?? "Module"},${numberValue(courseModule.position)},${textValue(courseModule.state)},${dateValue(courseModule.unlock_at)},now(),null,now())
        on conflict(course_id,canvas_module_id) do update set name=excluded.name,position=excluded.position,state=excluded.state,unlock_at=excluded.unlock_at,synced_at=now(),deleted_at=null,updated_at=now() returning id`;
      const moduleId = moduleRows[0]?.id; if (!moduleId) continue;
      if (entry.complete === true) await tx`update course_module_items set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and module_id=${moduleId} and deleted_at is null`;
      for (const item of records(courseModule.items)) {
        const itemId = textValue(item.id); if (!itemId) continue;
        await tx`insert into course_module_items(owner_id,module_id,canvas_module_item_id,title,position,item_type,content_canvas_id,page_url,html_url,completed,synced_at,deleted_at,updated_at)
          values(${job.ownerId},${moduleId},${itemId},${textValue(item.title) ?? "Module item"},${numberValue(item.position)},${textValue(item.type)},${textValue(item.content_id)},${textValue(item.page_url)},${textValue(item.html_url)},${object(item.completion_requirement).completed === true},now(),null,now())
          on conflict(module_id,canvas_module_item_id) do update set title=excluded.title,position=excluded.position,item_type=excluded.item_type,content_canvas_id=excluded.content_canvas_id,page_url=excluded.page_url,html_url=excluded.html_url,completed=excluded.completed,synced_at=now(),deleted_at=null,updated_at=now()`;
      }
    }
    for (const page of records(entry.pages)) {
      const slug = textValue(page.url); if (!slug) continue;
      await tx`insert into course_pages(owner_id,course_id,canvas_page_url,title,body_html,html_url,published,front_page,source_updated_at,synced_at,deleted_at,updated_at)
        values(${job.ownerId},${courseId},${slug},${textValue(page.title) ?? "Page"},${safeQuizHtml(page.body)},${textValue(page.html_url)},${booleanValue(page.published)},${booleanValue(page.front_page)},${dateValue(page.updated_at)},now(),null,now())
        on conflict(course_id,canvas_page_url) do update set title=excluded.title,body_html=excluded.body_html,html_url=excluded.html_url,published=excluded.published,front_page=excluded.front_page,source_updated_at=excluded.source_updated_at,synced_at=now(),deleted_at=null,updated_at=now()`;
    }
    for (const group of records(entry.groups)) {
      const groupCanvasId = textValue(group.id); if (!groupCanvasId) continue;
      const rules = object(group.rules);
      const groupRows = await tx<{ id: string }[]>`insert into assignment_groups(owner_id,course_id,canvas_assignment_group_id,name,position,group_weight,drop_lowest,drop_highest,never_drop_canvas_ids,synced_at,deleted_at,updated_at)
        values(${job.ownerId},${courseId},${groupCanvasId},${textValue(group.name) ?? "Assignment group"},${numberValue(group.position)},${numberValue(group.group_weight)},${numberValue(rules.drop_lowest) ?? 0},${numberValue(rules.drop_highest) ?? 0},${Array.isArray(rules.never_drop) ? rules.never_drop.map(textValue).filter((item): item is string => Boolean(item)) : []},now(),null,now())
        on conflict(course_id,canvas_assignment_group_id) do update set name=excluded.name,position=excluded.position,group_weight=excluded.group_weight,drop_lowest=excluded.drop_lowest,drop_highest=excluded.drop_highest,never_drop_canvas_ids=excluded.never_drop_canvas_ids,synced_at=now(),deleted_at=null,updated_at=now() returning id`;
      const groupId = groupRows[0]?.id; if (!groupId) continue;
      for (const assignment of records(group.assignments)) {
        const assignmentId = textValue(assignment.id); if (!assignmentId) continue;
        const types = Array.isArray(assignment.submission_types) ? assignment.submission_types.filter((item): item is string => typeof item === "string") : [];
        const assignmentRows = await tx<{ id: string }[]>`insert into assignments(owner_id,course_id,assignment_group_id,canvas_assignment_id,name,description_html,due_at,unlock_at,lock_at,points_possible,submission_types,workflow_state,grading_type,position,source_updated_at,synced_at,deleted_at,source_payload,updated_at)
          values(${job.ownerId},${courseId},${groupId},${assignmentId},${textValue(assignment.name) ?? "Assignment"},${safeQuizHtml(assignment.description)},${dateValue(assignment.due_at)},${dateValue(assignment.unlock_at)},${dateValue(assignment.lock_at)},${numberValue(assignment.points_possible)},${types},${textValue(assignment.workflow_state)},${textValue(assignment.grading_type)},${numberValue(assignment.position)},${dateValue(assignment.updated_at)},now(),null,${tx.json(assignment)},now())
          on conflict(course_id,canvas_assignment_id) do update set assignment_group_id=excluded.assignment_group_id,name=excluded.name,description_html=excluded.description_html,due_at=excluded.due_at,unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,points_possible=excluded.points_possible,submission_types=excluded.submission_types,workflow_state=excluded.workflow_state,grading_type=excluded.grading_type,position=excluded.position,source_updated_at=excluded.source_updated_at,synced_at=now(),deleted_at=null,source_payload=excluded.source_payload,updated_at=now() returning id`;
        const localAssignmentId = assignmentRows[0]?.id;
        const submission = object(assignment.submission);
        if (!localAssignmentId || !Object.keys(submission).length) continue;
        await tx`insert into submissions(owner_id,assignment_id,canvas_submission_id,attempt,state,submitted_at,graded_at,score,grade,late,missing,excused,source_updated_at,synced_at,source_payload,updated_at)
          values(${job.ownerId},${localAssignmentId},${textValue(submission.id)},${numberValue(submission.attempt) ?? 0},${textValue(submission.workflow_state)},${dateValue(submission.submitted_at)},${dateValue(submission.graded_at)},${numberValue(submission.score)},${textValue(submission.grade)},${booleanValue(submission.late)},${booleanValue(submission.missing)},${booleanValue(submission.excused)},${dateValue(submission.updated_at)},now(),${tx.json(submission)},now())
          on conflict(assignment_id,attempt) do update set canvas_submission_id=excluded.canvas_submission_id,state=excluded.state,submitted_at=excluded.submitted_at,graded_at=excluded.graded_at,score=excluded.score,grade=excluded.grade,late=excluded.late,missing=excluded.missing,excused=excluded.excused,source_updated_at=excluded.source_updated_at,synced_at=now(),source_payload=excluded.source_payload,updated_at=now()`;
      }
    }
  }
}

/** Upsert the student's own submission rows for assignments Grove already knows (never creates assignments). */
async function persistOwnSubmissions(tx: postgres.TransactionSql, job: Job, courses: CanvasRecord[]) {
  for (const course of courses) {
    const canvasCourseId = textValue(course.courseCanvasId); if (!canvasCourseId) continue;
    const local = await tx<{ id: string; canvas_assignment_id: string }[]>`select a.id,a.canvas_assignment_id from assignments a join courses c on c.owner_id=a.owner_id and c.id=a.course_id
      where a.owner_id=${job.ownerId} and c.canvas_account_id=${job.canvasAccountId} and c.canvas_course_id=${canvasCourseId} and a.deleted_at is null`;
    const byCanvasId = new Map(local.map((row) => [row.canvas_assignment_id, row.id]));
    for (const submission of records(course.rows)) {
      const localAssignmentId = byCanvasId.get(textValue(submission.assignment_id) ?? ""); if (!localAssignmentId) continue;
      await tx`insert into submissions(owner_id,assignment_id,canvas_submission_id,attempt,state,submitted_at,graded_at,score,grade,late,missing,excused,source_updated_at,synced_at,source_payload,updated_at)
        values(${job.ownerId},${localAssignmentId},${textValue(submission.id)},${numberValue(submission.attempt) ?? 0},${textValue(submission.workflow_state)},${dateValue(submission.submitted_at)},${dateValue(submission.graded_at)},${numberValue(submission.score)},${textValue(submission.grade)},${booleanValue(submission.late)},${booleanValue(submission.missing)},${booleanValue(submission.excused)},${dateValue(submission.updated_at)},now(),${tx.json(submission)},now())
        on conflict(assignment_id,attempt) do update set canvas_submission_id=excluded.canvas_submission_id,state=excluded.state,submitted_at=excluded.submitted_at,graded_at=excluded.graded_at,score=excluded.score,grade=excluded.grade,late=excluded.late,missing=excluded.missing,excused=excluded.excused,source_updated_at=excluded.source_updated_at,synced_at=now(),source_payload=excluded.source_payload,updated_at=now()`;
    }
  }
}

async function persistSyncRecords(tx: postgres.TransactionSql, job: Job, value: unknown) {
  const items = records(value);
  if (job.kind === "course_content") {
    await persistCourseContent(tx, job, value);
  } else if (job.kind === "quizzes") {
    const payload = object(value);
    for (const entry of records(payload.courses)) {
      const courseRaw = object(entry.course);
      const courseId = await upsertCourse(tx, job, courseRaw);
      if (!courseId) continue;
      const seen = new Set<string>();
      const assignmentRecords = records(entry.assignments);
      const assignmentsById = new Map(assignmentRecords.map((item) => [textValue(item.id), item]));
      const quizEntries = records(entry.quizzes);
      for (const quizEntry of quizEntries) {
        const raw = object(quizEntry.quiz);
        const canvasQuizId = textValue(raw.id);
        if (!canvasQuizId) continue;
        seen.add(canvasQuizId);
        const reason = restrictionReason(raw, "classic");
        const sourcePayload = {
          oneQuestionAtATime: booleanValue(raw.one_question_at_a_time), cantGoBack: booleanValue(raw.cant_go_back),
          requireLockdownBrowser: booleanValue(raw.require_lockdown_browser), requireLockdownMonitor: booleanValue(raw.require_lockdown_browser_monitor),
          accessCodeRequired: Boolean(raw.access_code), ipRestricted: Boolean(raw.ip_filter),
        };
        const quizRows = await tx<{ id: string }[]>`insert into quizzes(owner_id,canvas_account_id,course_id,canvas_quiz_id,canvas_assignment_id,engine,title,description_html,quiz_type,points_possible,question_count,time_limit_minutes,allowed_attempts,scoring_policy,due_at,unlock_at,lock_at,published,locked_for_user,lock_explanation,html_url,supported,unsupported_reason,source_payload,synced_at,deleted_at,updated_at)
          values(${job.ownerId},${job.canvasAccountId},${courseId},${canvasQuizId},${textValue(raw.assignment_id)},'classic',${textValue(raw.title) ?? "Untitled quiz"},${safeQuizHtml(raw.description)},${textValue(raw.quiz_type)},${numberValue(raw.points_possible)},${numberValue(raw.question_count)},${numberValue(raw.time_limit)},${numberValue(raw.allowed_attempts)},${textValue(raw.scoring_policy)},${dateValue(raw.due_at)},${dateValue(raw.unlock_at)},${dateValue(raw.lock_at)},${raw.published !== false},${booleanValue(raw.locked_for_user)},${textValue(raw.lock_explanation)},${textValue(raw.html_url)},${reason == null},${reason},${tx.json(sourcePayload)},now(),null,now())
          on conflict(course_id,canvas_quiz_id) do update set canvas_assignment_id=excluded.canvas_assignment_id,engine='classic',title=excluded.title,description_html=excluded.description_html,quiz_type=excluded.quiz_type,points_possible=excluded.points_possible,question_count=excluded.question_count,time_limit_minutes=excluded.time_limit_minutes,allowed_attempts=excluded.allowed_attempts,scoring_policy=excluded.scoring_policy,due_at=excluded.due_at,unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,published=excluded.published,locked_for_user=excluded.locked_for_user,lock_explanation=excluded.lock_explanation,html_url=excluded.html_url,supported=excluded.supported,unsupported_reason=excluded.unsupported_reason,source_payload=excluded.source_payload,synced_at=now(),deleted_at=null,updated_at=now() returning id`;
        const directSubmission = object(quizEntry.submission);
        const assignmentSubmission = object(object(assignmentsById.get(textValue(raw.assignment_id))).submission);
        const submission = Object.keys(directSubmission).length ? directSubmission : assignmentSubmission;
        const submissionId = textValue(submission.id);
        if (submissionId && quizRows[0]) {
          await tx`insert into quiz_attempts(owner_id,quiz_id,canvas_quiz_submission_id,attempt,workflow_state,started_at,finished_at,end_at,score,kept_score,time_spent_seconds,last_observed_at,updated_at)
            values(${job.ownerId},${quizRows[0].id},${submissionId},${numberValue(submission.attempt) ?? 1},${textValue(submission.workflow_state) ?? "unknown"},${dateValue(submission.started_at)},${dateValue(submission.finished_at) ?? dateValue(submission.submitted_at)},${dateValue(submission.end_at)},${numberValue(submission.score)},${numberValue(submission.kept_score)},${numberValue(submission.time_spent)},now(),now())
            on conflict(quiz_id,canvas_quiz_submission_id) do update set attempt=excluded.attempt,workflow_state=excluded.workflow_state,started_at=excluded.started_at,finished_at=excluded.finished_at,end_at=excluded.end_at,score=excluded.score,kept_score=excluded.kept_score,time_spent_seconds=excluded.time_spent_seconds,last_observed_at=now(),updated_at=now()`;
        }
      }
      for (const assignment of assignmentRecords) {
        const types = Array.isArray(assignment.submission_types) ? assignment.submission_types.filter((item): item is string => typeof item === "string") : [];
        const assignmentId = textValue(assignment.id);
        if (!assignmentId || !types.includes("external_tool") || !(assignment.is_quiz_assignment === true || assignment.quiz_lti || /quiz/i.test(String(assignment.name ?? "")))) continue;
        const canvasQuizId = `assignment-${assignmentId}`; seen.add(canvasQuizId);
        const reason = restrictionReason({ ...assignment, submission_types: types, is_quiz_assignment: true }, "new_quiz");
        await tx`insert into quizzes(owner_id,canvas_account_id,course_id,canvas_quiz_id,canvas_assignment_id,engine,title,points_possible,due_at,unlock_at,lock_at,published,locked_for_user,html_url,supported,unsupported_reason,source_payload,synced_at,deleted_at,updated_at)
          values(${job.ownerId},${job.canvasAccountId},${courseId},${canvasQuizId},${assignmentId},'new_quiz',${textValue(assignment.name) ?? "Untitled quiz"},${numberValue(assignment.points_possible)},${dateValue(assignment.due_at)},${dateValue(assignment.unlock_at)},${dateValue(assignment.lock_at)},${assignment.published !== false},${booleanValue(assignment.locked_for_user)},${textValue(assignment.html_url)},false,${reason ?? "New Quizzes must be completed in Canvas."},${tx.json({ externalTool: true })},now(),null,now())
          on conflict(course_id,canvas_quiz_id) do update set canvas_assignment_id=excluded.canvas_assignment_id,title=excluded.title,points_possible=excluded.points_possible,due_at=excluded.due_at,unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,published=excluded.published,locked_for_user=excluded.locked_for_user,html_url=excluded.html_url,supported=false,unsupported_reason=excluded.unsupported_reason,source_payload=excluded.source_payload,synced_at=now(),deleted_at=null,updated_at=now()`;
      }
      if (entry.complete === true) {
        const existing = await tx<{ id: string; canvas_quiz_id: string }[]>`select id,canvas_quiz_id from quizzes where owner_id=${job.ownerId} and course_id=${courseId} and deleted_at is null`;
        for (const row of existing) if (!seen.has(row.canvas_quiz_id)) await tx`update quizzes set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and id=${row.id}`;
      }
    }
  } else if (job.kind === "courses" || job.kind === "grades") {
    for (const item of items) await upsertCourse(tx, job, item);
  } else if (job.kind === "favorites") {
    await tx`update courses set favorite=false,updated_at=now() where owner_id=${job.ownerId} and canvas_account_id=${job.canvasAccountId} and deleted_at is null`;
    for (const item of items) await upsertCourse(tx, job, { ...item, is_favorite: true });
  } else if (job.kind === "assignments") {
    // Payload: { events: upcoming_events[], submissions: [{ courseCanvasId, rows }] } (legacy: bare events array).
    const payload = Array.isArray(value) ? { events: value, submissions: [] } : object(value);
    const items = records(payload.events);
    await persistOwnSubmissions(tx, job, records(payload.submissions));
    // upcoming_events mixes assignments with plain calendar events (type "event").
    // Calendar events are not assignments: storing them used calendar-event ids as
    // canvas_assignment_id and showed phantom assignments. Retire any stored earlier.
    await tx`update assignments set deleted_at=now(),updated_at=now() where owner_id=${job.ownerId} and deleted_at is null and assignment_group_id is null and source_payload->>'type'='event'`;
    for (const event of items) {
      if (!isAssignmentEvent(event)) continue;
      const assignment = Object.keys(object(event.assignment)).length ? object(event.assignment) : event;
      const canvasAssignmentId = textValue(assignment.id) ?? textValue(event.id);
      const courseId = await ensureCourse(tx, job, { ...event, course_id: assignment.course_id ?? event.course_id });
      if (!canvasAssignmentId || !courseId) continue;
      const submissionTypes = Array.isArray(assignment.submission_types) ? assignment.submission_types.filter((item): item is string => typeof item === "string") : [];
      await tx`insert into assignments(owner_id,course_id,canvas_assignment_id,name,description_html,due_at,unlock_at,lock_at,points_possible,submission_types,workflow_state,grading_type,position,source_updated_at,synced_at,deleted_at,source_payload,updated_at)
        values(${job.ownerId},${courseId},${canvasAssignmentId},${textValue(assignment.name) ?? textValue(event.title) ?? "Untitled assignment"},${textValue(assignment.description)},${dateValue(assignment.due_at) ?? dateValue(event.start_at)},${dateValue(assignment.unlock_at)},${dateValue(assignment.lock_at)},${numberValue(assignment.points_possible)},${submissionTypes},${textValue(assignment.workflow_state)},${textValue(assignment.grading_type)},${numberValue(assignment.position)},${dateValue(assignment.updated_at)},now(),null,${tx.json(event)},now())
        on conflict(course_id,canvas_assignment_id) do update set name=excluded.name,description_html=excluded.description_html,due_at=excluded.due_at,unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,points_possible=excluded.points_possible,submission_types=excluded.submission_types,workflow_state=excluded.workflow_state,grading_type=excluded.grading_type,position=excluded.position,source_updated_at=excluded.source_updated_at,synced_at=now(),deleted_at=null,source_payload=excluded.source_payload,updated_at=now()`;
    }
  } else if (job.kind === "planner") {
    for (const item of items) {
      const plannable = object(item.plannable);
      const externalId = textValue(item.plannable_id) ?? textValue(plannable.id) ?? textValue(item.id);
      const itemType = textValue(item.plannable_type) ?? textValue(item.type) ?? "planner_item";
      if (!externalId) continue;
      const courseId = await ensureCourse(tx, job, item);
      const assignmentRows = itemType.toLowerCase().includes("assignment") && courseId
        ? await tx<{ id: string }[]>`select id from assignments where owner_id=${job.ownerId} and course_id=${courseId} and canvas_assignment_id=${externalId} limit 1`
        : [];
      const status = object(item.submissions).submitted === true || object(item.submissions).graded === true ? "completed" : "todo";
      await tx`insert into planner_items(owner_id,canvas_account_id,course_id,assignment_id,source,canvas_item_type,canvas_item_id,kind,title,notes,starts_at,due_at,completed_at,status,priority,updated_at)
        values(${job.ownerId},${job.canvasAccountId},${courseId},${assignmentRows[0]?.id ?? null},'canvas',${itemType},${externalId},${itemType},${textValue(plannable.title) ?? textValue(plannable.name) ?? textValue(item.title) ?? "Canvas item"},null,${dateValue(item.plannable_date) ?? dateValue(plannable.start_at)},${dateValue(plannable.due_at) ?? dateValue(item.plannable_date)},${status === "completed" ? dateValue(object(item.submissions).submitted_at) ?? new Date().toISOString() : null},${status},0,now())
        on conflict(canvas_account_id,canvas_item_type,canvas_item_id) where source='canvas' do update set course_id=excluded.course_id,assignment_id=coalesce(excluded.assignment_id,planner_items.assignment_id),kind=excluded.kind,title=excluded.title,starts_at=excluded.starts_at,due_at=excluded.due_at,completed_at=excluded.completed_at,status=excluded.status,deleted_at=null,updated_at=now()`;
    }
  } else if (job.kind === "inbox") {
    for (const item of items) {
      const externalId = textValue(item.id); if (!externalId) continue;
      const courseId = await ensureCourse(tx, job, item);
      await tx`insert into conversations(owner_id,canvas_account_id,course_id,canvas_conversation_id,subject,workflow_state,last_message_at,message_count,starred,participants,source_payload,synced_at,updated_at)
        values(${job.ownerId},${job.canvasAccountId},${courseId},${externalId},${textValue(item.subject)},${textValue(item.workflow_state)},${dateValue(item.last_message_at) ?? dateValue(item.last_message)},${numberValue(item.message_count) ?? 0},${booleanValue(item.starred)},${tx.json(Array.isArray(item.participants) ? item.participants : [])},${tx.json(item)},now(),now())
        on conflict(canvas_account_id,canvas_conversation_id) do update set course_id=coalesce(excluded.course_id,conversations.course_id),subject=excluded.subject,workflow_state=excluded.workflow_state,last_message_at=excluded.last_message_at,message_count=excluded.message_count,starred=excluded.starred,participants=excluded.participants,source_payload=excluded.source_payload,synced_at=now(),updated_at=now()`;
    }
  } else if (job.kind === "announcements") {
    for (const item of items) {
      const type = (textValue(item.type) ?? "").toLowerCase();
      if (type && !["announcement", "discussion_topic", "message"].some((value) => type.includes(value))) continue;
      const externalId = textValue(item.id); if (!externalId) continue;
      const courseId = await ensureCourse(tx, job, item);
      await tx`insert into announcements(owner_id,canvas_account_id,course_id,canvas_announcement_id,title,body_html,posted_at,html_url,source_payload,synced_at,updated_at)
        values(${job.ownerId},${job.canvasAccountId},${courseId},${externalId},${textValue(item.title) ?? "Canvas announcement"},${textValue(item.message)},${dateValue(item.created_at) ?? dateValue(item.updated_at)},${textValue(item.html_url)},${tx.json(item)},now(),now())
        on conflict(canvas_account_id,canvas_announcement_id) do update set course_id=coalesce(excluded.course_id,announcements.course_id),title=excluded.title,body_html=excluded.body_html,posted_at=excluded.posted_at,html_url=excluded.html_url,source_payload=excluded.source_payload,synced_at=now(),updated_at=now()`;
    }
  }
  await tx`update canvas_accounts set last_synced_at=now(),updated_at=now() where owner_id=${job.ownerId} and id=${job.canvasAccountId}`;
}

function providerId(ref: string) {
  try {
    const value = JSON.parse(Buffer.from(ref, "base64url").toString("utf8")) as { id?: unknown };
    return typeof value.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id) ? value.id : null;
  } catch { return null; }
}

// Only sessions still in interactive sign-in own a browser. An 'active'
// session's browser is destroyed after cookie capture (sync is direct API), so
// it is deliberately NOT protected: any leftover is reclaimed after the grace.
async function reconcileBrowserOwnership(owners: { id: string }[]) {
  const owned = new Set<string>();
  for (const owner of owners) {
    const refs = await tenant(owner.id, (tx) => tx<{ provider_session_ref: string }[]>`
      select provider_session_ref from hosted_browser_sessions
      where owner_id=${owner.id} and revoked_at is null and status in ('provisioning','auth_required','failed')
        and provider_session_ref is not null and provider_session_ref not like 'pending:%' and provider_session_ref not like 'revoked:%'`);
    for (const row of refs) { const id = providerId(row.provider_session_ref); if (id) owned.add(id); }
  }
  const base = process.env.BROWSER_ORCHESTRATOR_URL?.replace(/\/$/, "");
  const secret = process.env.BROWSER_ORCHESTRATOR_SECRET;
  if (!base || !secret) return;
  const path = "/v1/reconcile", method = "POST", body = JSON.stringify({ ownedSessionIds: [...owned].sort() });
  const timestamp = String(Date.now()), nonce = randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`).digest("base64url");
  const response = await fetch(`${base}${path}`, { method, body, headers: { "content-type": "application/json", "x-orchestrator-timestamp": timestamp, "x-orchestrator-nonce": nonce, "x-orchestrator-signature": signature }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Browser ownership reconcile returned HTTP ${response.status}`);
  const result = await response.json() as { removed?: number; quarantined?: number; protected?: number };
  console.log(`browser-reconcile removed=${result.removed ?? 0} quarantined=${result.quarantined ?? 0} protected=${result.protected ?? 0}`);
}

async function tenant<T>(ownerId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${ownerId}, true)`;
    return work(tx);
  });
}

async function bootstrapPolicies(ownerId: string) {
  await tenant(ownerId, async (tx) => {
    await tx`update interactive_session_monitors m set status='cancelled',finished_at=now(),lease_owner=null,lease_token_hash=null,lease_expires_at=null,last_error_code='SUPERSEDED_SESSION',updated_at=now()
      from hosted_browser_sessions s where m.owner_id=${ownerId} and m.hosted_session_id=s.id and m.status in ('queued','leased')
        and exists(select 1 from hosted_browser_sessions newer where newer.owner_id=s.owner_id and newer.profile_id=s.profile_id and newer.created_at>s.created_at and newer.revoked_at is null)`;
    const accounts = await tx<{ id: string }[]>`select id from canvas_accounts where owner_id=${ownerId} and status='connected'`;
    for (const account of accounts) for (const kind of kinds) {
      const policy = syncPolicies[kind];
      await tx`insert into sync_policies(owner_id,canvas_account_id,resource_type,interval_seconds,freshness_seconds,priority,next_run_at)
        values(${ownerId},${account.id},${kind},${Math.round(policy.intervalMs / 1000)},${Math.round(policy.staleAfterMs / 1000)},${policy.priority},now())
        on conflict(canvas_account_id,resource_type,scope_key) do update set interval_seconds=excluded.interval_seconds,freshness_seconds=excluded.freshness_seconds,priority=excluded.priority,
          next_run_at=least(sync_policies.next_run_at,now()+(excluded.interval_seconds*interval '1 second')),updated_at=now()
        where (sync_policies.interval_seconds,sync_policies.freshness_seconds,sync_policies.priority) is distinct from (excluded.interval_seconds,excluded.freshness_seconds,excluded.priority)`;
    }
  });
}

async function bootstrapAuthMonitors(ownerId: string) {
  const cleanup = await tenant(ownerId, async (tx) => {
    await tx`update hosted_browser_sessions s set status='auth_required',failure_code='INTERACTIVE_AUTH_TIMEOUT_CLEANUP_PENDING',last_auth_check_at=now(),updated_at=now()
      from interactive_session_monitors m where s.owner_id=${ownerId} and m.owner_id=s.owner_id and m.hosted_session_id=s.id
        and m.auth_attempt_id=s.interactive_attempt_id and m.status in ('queued','leased') and m.deadline_at<=now() and s.status<>'active'`;
    await tx`insert into interactive_session_monitors(owner_id,hosted_session_id,auth_attempt_id,status,next_check_at,deadline_at)
      select s.owner_id,s.id,s.interactive_attempt_id,'queued',now(),s.interactive_attempt_deadline_at
      from hosted_browser_sessions s
      where s.owner_id=${ownerId} and s.status in ('provisioning','auth_required','failed') and s.revoked_at is null
        and s.interactive_attempt_id is not null and s.interactive_attempt_deadline_at is not null
        and (s.failure_code is null or s.failure_code not in ('INTERACTIVE_AUTH_TIMEOUT','INTERACTIVE_AUTH_TIMEOUT_CLEANUP_PENDING'))
        and not (s.status='auth_required' and coalesce(s.failure_code,'') in ('BROWSER_SESSION_NOT_FOUND','AUTH_REQUIRED'))
        and s.provider_session_ref is not null and s.provider_session_ref not like 'pending:%'
        and not exists(select 1 from hosted_browser_sessions newer where newer.owner_id=s.owner_id and newer.profile_id=s.profile_id and newer.created_at>s.created_at and newer.revoked_at is null)
        and not exists(select 1 from interactive_session_monitors m where m.owner_id=s.owner_id and m.hosted_session_id=s.id and m.status in ('queued','leased'))
      on conflict do nothing`;
    return tx<{ id: string; provider_session_ref: string; interactive_attempt_id: string; monitor_id: string; deadline_at: Date; canvas_origin: string; institution_name: string; auth_host_rules: string[]; login_path: string }[]>`
      select s.id,s.provider_session_ref,s.interactive_attempt_id,m.id monitor_id,m.deadline_at,p.canvas_origin,p.institution_name,p.auth_host_rules,p.login_path
      from hosted_browser_sessions s join interactive_session_monitors m on m.owner_id=s.owner_id and m.hosted_session_id=s.id and m.auth_attempt_id=s.interactive_attempt_id
      join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
      where s.owner_id=${ownerId} and s.status='auth_required' and s.failure_code='INTERACTIVE_AUTH_TIMEOUT_CLEANUP_PENDING'
        and m.status in ('queued','leased') and s.provider_session_ref is not null`;
  });
  for (const session of cleanup) {
    // Resolve the exact deadline race in favor of a completed authentication.
    // A successful probe makes the session active; every other state follows
    // the durable, idempotent cleanup path and remains retryable after restart.
    const pendingProvider = session.provider_session_ref.startsWith("pending:");
    const observed = pendingProvider ? null : await hostedBrowserProvider.status(session.provider_session_ref).catch(() => null);
    if (observed?.state === "active" && observed.canvasAccountId) {
      try {
        const monitor: Monitor = { monitorId: session.monitor_id, attemptId: session.interactive_attempt_id, ownerId, hostedSessionId: session.id, providerSessionRef: session.provider_session_ref, canvasOrigin: session.canvas_origin, institutionName: session.institution_name, authHostRules: session.auth_host_rules, loginPath: toCanvasLoginPath(session.login_path), deadlineAt: session.deadline_at };
        const encrypted = await hostedBrowserProvider.snapshotEncrypted(session.provider_session_ref, ownerId);
        // Login-only browser: destroyed once the cookie jar is committed.
        if (await completeAuthentication(monitor, observed.canvasAccountId, encrypted)) {
          await releaseLoginBrowser(hostedBrowserProvider, session.provider_session_ref);
        }
      } catch { /* snapshot/finalization failure is retried; never terminate an observed authenticated runtime */ }
      continue;
    }
    // A browser that no longer exists is already terminated; without this the
    // cleanup would retry a DELETE for a missing container on every loop.
    const terminated = pendingProvider || await hostedBrowserProvider.terminate(session.provider_session_ref).then(() => true)
      .catch((error) => error instanceof BridgeError && error.code === "BROWSER_SESSION_NOT_FOUND");
    if (terminated) await tenant(ownerId, async (tx) => {
      await tx`update hosted_browser_sessions set status='expired',failure_code='INTERACTIVE_AUTH_TIMEOUT',last_auth_check_at=now(),updated_at=now() where owner_id=${ownerId} and id=${session.id} and interactive_attempt_id=${session.interactive_attempt_id} and failure_code='INTERACTIVE_AUTH_TIMEOUT_CLEANUP_PENDING'`;
      await tx`update interactive_session_monitors set status='failed',last_error_code='INTERACTIVE_AUTH_TIMEOUT',finished_at=now(),lease_owner=null,lease_token_hash=null,lease_expires_at=null,updated_at=now() where owner_id=${ownerId} and id=${session.monitor_id} and auth_attempt_id=${session.interactive_attempt_id}`;
    });
  }
}

async function claimAuthMonitor(ownerId: string): Promise<Monitor | null> {
  const leaseToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(leaseToken).digest("hex");
  return tenant(ownerId, async (tx) => {
    await tx`update interactive_session_monitors set status='queued',lease_owner=null,lease_token_hash=null,lease_expires_at=null,next_check_at=now(),updated_at=now()
      where owner_id=${ownerId} and status='leased' and lease_expires_at<now() and deadline_at>now()`;
    const rows = await tx<{ id: string; auth_attempt_id: string; hosted_session_id: string; provider_session_ref: string; canvas_origin: string; institution_name: string; auth_host_rules: string[]; login_path: string; deadline_at: Date }[]>`
      with candidate as (select id from interactive_session_monitors where owner_id=${ownerId} and status='queued' and next_check_at<=now() and deadline_at>now() order by next_check_at for update skip locked limit 1)
      update interactive_session_monitors m set status='leased',lease_owner=${workerId},lease_token_hash=${tokenHash},lease_expires_at=now()+interval '60 seconds',heartbeat_at=now(),check_count=check_count+1,updated_at=now()
      from candidate,hosted_browser_sessions s,hosted_browser_profiles p where m.id=candidate.id and s.owner_id=m.owner_id and s.id=m.hosted_session_id
        and s.interactive_attempt_id=m.auth_attempt_id and p.owner_id=s.owner_id and p.id=s.profile_id
      returning m.id,m.auth_attempt_id,m.hosted_session_id,s.provider_session_ref,p.canvas_origin,p.institution_name,p.auth_host_rules,p.login_path,m.deadline_at`;
    const row = rows[0];
    return row ? { monitorId: row.id, attemptId: row.auth_attempt_id, ownerId, hostedSessionId: row.hosted_session_id, providerSessionRef: row.provider_session_ref, canvasOrigin: row.canvas_origin, institutionName: row.institution_name, authHostRules: row.auth_host_rules, loginPath: toCanvasLoginPath(row.login_path), deadlineAt: row.deadline_at, leaseToken } : null;
  });
}

async function rescheduleMonitor(monitor: Monitor, observed: string, errorCode?: string) {
  if (!monitor.leaseToken) return;
  const tokenHash = createHash("sha256").update(monitor.leaseToken).digest("hex");
  await tenant(monitor.ownerId, async (tx) => {
    await tx`update hosted_browser_sessions set last_auth_check_at=now(),failure_code=${errorCode ?? null},updated_at=now() where owner_id=${monitor.ownerId} and id=${monitor.hostedSessionId} and interactive_attempt_id=${monitor.attemptId}`;
    await tx`update interactive_session_monitors set status='queued',
      next_check_at=now()+(${observed === "awaiting-login" || observed === "provisioning" ? INTERACTIVE_RECHECK_MS : 5000}*interval '1 millisecond'),lease_owner=null,lease_token_hash=null,lease_expires_at=null,last_observed_state=${observed},last_error_code=${errorCode ?? null},finished_at=null,updated_at=now()
      where owner_id=${monitor.ownerId} and id=${monitor.monitorId} and auth_attempt_id=${monitor.attemptId} and lease_token_hash=${tokenHash}`;
  });
}

// One shared, transactional finalizer (lib/bridge/complete-authentication.ts):
// the fast /confirm route and this monitor race safely on the same locked rows.
async function completeAuthentication(monitor: Monitor, canvasUserId: string, encrypted: EncryptedBrowserState): Promise<boolean> {
  return tenant(monitor.ownerId, (tx) => completeAuthenticationTx(tx, monitor, canvasUserId, encrypted));
}

async function runAuthMonitor(monitor: Monitor) {
  try {
    const result = await hostedBrowserProvider.status(monitor.providerSessionRef);
    if (result.state === "active" && result.canvasAccountId) {
      const encrypted = await hostedBrowserProvider.snapshotEncrypted(monitor.providerSessionRef, monitor.ownerId);
      if (await completeAuthentication(monitor, result.canvasAccountId, encrypted)) await releaseLoginBrowser(hostedBrowserProvider, monitor.providerSessionRef);
    }
    else await rescheduleMonitor(monitor, result.state, result.state === "failed" ? "BROWSER_PROBE_FAILED" : undefined);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as Error & { code: unknown }).code) : "BROWSER_PROBE_FAILED";
    const current = await tenant(monitor.ownerId, (tx) => tx<{ status: string }[]>`
      select status from hosted_browser_sessions where owner_id=${monitor.ownerId} and id=${monitor.hostedSessionId} and revoked_at is null limit 1`);
    const repairAction = monitorRepairAction(current[0]?.status, code);
    if (repairAction === "stop-auth-required") {
      const tokenHash = createHash("sha256").update(monitor.leaseToken!).digest("hex");
      await tenant(monitor.ownerId, async (tx) => {
        const stopped = await tx<{ id: string }[]>`update interactive_session_monitors set status='failed',finished_at=now(),lease_owner=null,
          lease_token_hash=null,lease_expires_at=null,last_observed_state='auth_required',last_error_code='AUTH_REQUIRED',updated_at=now()
          where owner_id=${monitor.ownerId} and id=${monitor.monitorId} and lease_token_hash=${tokenHash} returning id`;
        // Record why the monitor stopped on the session itself. Without this the
        // session keeps a NULL failure_code and bootstrapAuthMonitors would
        // immediately enqueue a replacement monitor for the same dead browser.
        if (stopped.length) await tx`update hosted_browser_sessions set failure_code='BROWSER_SESSION_NOT_FOUND',last_auth_check_at=now(),updated_at=now()
          where owner_id=${monitor.ownerId} and id=${monitor.hostedSessionId} and interactive_attempt_id=${monitor.attemptId} and status='auth_required'`;
      });
      return;
    }
    if (repairAction === "repair-once") {
      let replacementId: string | undefined;
      try {
        // Terminate only the exact handle whose deep status probe failed. The
        // monitor lease serializes this repair and the replacement reference
        // is committed before the lease is released.
        await hostedBrowserProvider.terminate(monitor.providerSessionRef).catch(() => undefined);
        const replacement = await hostedBrowserProvider.provision({ ownerId: monitor.ownerId, canvasOrigin: monitor.canvasOrigin, authHostRules: monitor.authHostRules, loginPath: monitor.loginPath });
        replacementId = replacement.providerSessionId;
        // A freshly claimed warm browser is intentionally blank. Commit an
        // allowlisted Canvas login target before the next deep-health probe so
        // it is not mistaken for another broken renderer.
        await hostedBrowserProvider.navigate(replacement.providerSessionId, "canvas-login");
        const tokenHash = createHash("sha256").update(monitor.leaseToken!).digest("hex");
        const committed = await tenant(monitor.ownerId, async (tx) => tx<{ id: string }[]>`
          update hosted_browser_sessions s set provider_session_ref=${replacement.providerSessionId},status='auth_required',failure_code='BROWSER_SESSION_REPROVISIONED',last_auth_check_at=now(),updated_at=now()
          where s.owner_id=${monitor.ownerId} and s.id=${monitor.hostedSessionId} and s.provider_session_ref=${monitor.providerSessionRef}
            and s.interactive_attempt_id=${monitor.attemptId}
            and exists(select 1 from interactive_session_monitors m where m.owner_id=s.owner_id and m.id=${monitor.monitorId} and m.auth_attempt_id=${monitor.attemptId} and m.status='leased' and m.lease_token_hash=${tokenHash})
          returning s.id`);
        if (!committed.length) {
          await hostedBrowserProvider.terminate(replacement.providerSessionId).catch(() => undefined);
          return;
        }
        await rescheduleMonitor(monitor, "awaiting-login", "BROWSER_SESSION_REPROVISIONED");
        return;
      } catch {
        if (replacementId) await hostedBrowserProvider.terminate(replacementId).catch(() => undefined);
        /* retain the stable original failure and retry under the durable lease */
      }
    }
    await rescheduleMonitor(monitor, "failed", code);
  }
}

async function scheduleDue(ownerId: string) {
  await tenant(ownerId, async (tx) => {
    const due = await tx<{ id: string; canvas_account_id: string; resource_type: SyncKind; interval_seconds: number; priority: number }[]>`
      select id,canvas_account_id,resource_type,interval_seconds,priority from sync_policies
      where owner_id=${ownerId} and status='active' and next_run_at<=now() order by next_run_at for update skip locked`;
    for (const policy of due) {
      const jitterMs = deterministicJitterMs(policy.canvas_account_id, policy.resource_type);
      const dedupe = `${policy.canvas_account_id}:${policy.resource_type}`;
      await tx`insert into sync_jobs(owner_id,canvas_account_id,policy_id,hosted_session_id,kind,scope,dedupe_key,status,priority,max_attempts,run_after)
        select ${ownerId},${policy.canvas_account_id},${policy.id},s.id,${policy.resource_type},${tx.json({})},${dedupe},'queued',${policy.priority},5,now()
        from hosted_browser_sessions s where s.owner_id=${ownerId} and s.canvas_account_id=${policy.canvas_account_id} and s.status='active'
        order by s.updated_at desc limit 1 on conflict do nothing`;
      await tx`update sync_policies set last_enqueued_at=now(),next_run_at=now()+(${policy.interval_seconds}*interval '1 second')+(${jitterMs}*interval '1 millisecond'),updated_at=now() where id=${policy.id}`;
    }
  });
}

export async function claimNext(ownerId: string): Promise<Job | null> {
  const leaseToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(leaseToken).digest("hex");
  return tenant(ownerId, async (tx) => {
    await tx`update sync_jobs set status='queued',lease_owner=null,lease_token_hash=null,lease_expires_at=null,run_after=now(),updated_at=now()
      where owner_id=${ownerId} and status in ('leased','running') and lease_expires_at<now() and attempt<max_attempts`;
    // A job runs only while its account has an ACTIVE session (captured cookie
    // jar), and is bound to that session at claim time. Jobs for an account
    // whose session needs sign-in wait queued without burning attempts.
    const rows = await tx<{ id: string; canvas_account_id: string; hosted_session_id: string; canvas_origin: string; kind: SyncKind; scope: unknown; attempt: number }[]>`
      with candidate as (
        select j.id,(select s.id from hosted_browser_sessions s where s.owner_id=j.owner_id and s.canvas_account_id=j.canvas_account_id
            and s.status='active' and s.revoked_at is null order by s.updated_at desc limit 1) session_id
        from sync_jobs j where j.owner_id=${ownerId} and j.status='queued' and j.run_after<=now()
          and not exists(select 1 from sync_jobs active where active.canvas_account_id=j.canvas_account_id and active.status in ('leased','running'))
          and exists(select 1 from hosted_browser_sessions s where s.owner_id=j.owner_id and s.canvas_account_id=j.canvas_account_id and s.status='active' and s.revoked_at is null)
        order by j.priority desc,j.run_after for update of j skip locked limit 1
      ) update sync_jobs j set status='leased',attempt=j.attempt+1,lease_owner=${workerId},lease_token_hash=${tokenHash},hosted_session_id=candidate.session_id,
        lease_expires_at=now()+(${leaseSeconds}*interval '1 second'),heartbeat_at=now(),started_at=coalesce(started_at,now()),updated_at=now()
      from candidate,hosted_browser_sessions s,hosted_browser_profiles p where j.id=candidate.id and s.owner_id=j.owner_id and s.id=candidate.session_id
        and p.owner_id=s.owner_id and p.id=s.profile_id
      returning j.id,j.canvas_account_id,s.id hosted_session_id,p.canvas_origin,j.kind,j.scope,j.attempt`;
    const row = rows[0];
    return row ? { jobId: row.id, ownerId, canvasAccountId: row.canvas_account_id, hostedSessionId: row.hosted_session_id, canvasOrigin: row.canvas_origin, kind: row.kind, scope: row.scope, attempt: row.attempt, leaseToken, leaseOwner: workerId } : null;
  });
}

async function heartbeat(job: Job) {
  const hash = createHash("sha256").update(job.leaseToken).digest("hex");
  await tenant(job.ownerId, async (tx) => { await tx`update sync_jobs set status='running',heartbeat_at=now(),lease_expires_at=now()+(${leaseSeconds}*interval '1 second'),updated_at=now() where id=${job.jobId} and lease_owner=${workerId} and lease_token_hash=${hash}`; });
}

async function complete(job: Job, records: unknown) {
  const count = Array.isArray(records) ? records.length : records == null ? 0 : 1;
  await tenant(job.ownerId, async (tx) => {
    await persistSyncRecords(tx, job, records);
    await tx`update sync_jobs set status='succeeded',finished_at=now(),lease_expires_at=null,stats=${tx.json({ records: count })},updated_at=now() where id=${job.jobId} and lease_owner=${workerId}`;
    await tx`insert into sync_cursors(owner_id,canvas_account_id,resource_type,scope_key,last_attempt_at,last_success_at,fresh_until,consecutive_failures,updated_at)
      values(${job.ownerId},${job.canvasAccountId},${job.kind},'',now(),now(),now()+(select freshness_seconds*interval '1 second' from sync_policies where owner_id=${job.ownerId} and canvas_account_id=${job.canvasAccountId} and resource_type=${job.kind}),0,now())
      on conflict(canvas_account_id,resource_type,scope_key) do update set last_attempt_at=now(),last_success_at=now(),fresh_until=excluded.fresh_until,consecutive_failures=0,last_error_code=null,last_error_message=null,updated_at=now()`;
    await tx`update sync_policies set last_success_at=now(),consecutive_failures=0,last_error_at=null,last_error_code=null,updated_at=now() where owner_id=${job.ownerId} and canvas_account_id=${job.canvasAccountId} and resource_type=${job.kind}`;
    if (job.kind === "quizzes") {
      // A short, bounded cadence near a deadline (or while an attempt is
      // active) keeps the DB-first hub warm without polling every quiz at that
      // rate for the rest of the term.
      // Each sweep is ~140 Canvas requests, so the 60s path is reserved for an
      // open attempt; an imminent deadline gets a 5-minute cadence.
      const [hot] = await tx<{ attempt: boolean; deadline: boolean }[]>`select
          exists(select 1 from quiz_attempts qa join quizzes q on q.owner_id=qa.owner_id and q.id=qa.quiz_id where qa.owner_id=${job.ownerId} and q.canvas_account_id=${job.canvasAccountId} and qa.finished_at is null and qa.workflow_state='untaken' and qa.started_at is not null and coalesce(qa.end_at, qa.started_at + interval '3 hours') >= now()) attempt,
          false deadline`;
      const dated = await tx<{ due_at: Date | null; unlock_at: Date | null; lock_at: Date | null }[]>`select due_at,unlock_at,lock_at from quizzes q where q.owner_id=${job.ownerId} and q.canvas_account_id=${job.canvasAccountId} and q.deleted_at is null
        and greatest(q.due_at,q.unlock_at,q.lock_at) >= now()`;
      const deadlineHot = dated.some((q) => isQuizHot({ dueAt: q.due_at, unlockAt: q.unlock_at, lockAt: q.lock_at }));
      const hotSeconds = hot?.attempt ? QUIZ_ATTEMPT_RESYNC_SECONDS : deadlineHot ? QUIZ_DEADLINE_RESYNC_SECONDS : null;
      if (hotSeconds !== null) await tx`update sync_policies set next_run_at=least(next_run_at,now()+(${hotSeconds}*interval '1 second')),updated_at=now()
        where owner_id=${job.ownerId} and canvas_account_id=${job.canvasAccountId} and resource_type='quizzes'`;
    }
  });
}

async function fail(job: Job, code: string, message: string, options: { authExpired?: boolean; retryAfterMs?: number } = {}) {
  await tenant(job.ownerId, async (tx) => {
    if (options.authExpired) await markCanvasSessionExpired(tx, job.ownerId, job.hostedSessionId, job.canvasAccountId);
    const retryMs = options.retryAfterMs ?? backoffMs(job.attempt);
    await tx`update sync_jobs set status=case when ${options.authExpired ?? false} or attempt>=max_attempts then 'failed'::sync_job_status else 'queued'::sync_job_status end,
      run_after=now()+(${retryMs}*interval '1 millisecond'),lease_owner=null,lease_token_hash=null,lease_expires_at=null,error_code=${code},error_message=${message.slice(0, 500)},finished_at=case when ${options.authExpired ?? false} or attempt>=max_attempts then now() else null end,updated_at=now() where id=${job.jobId} and lease_owner=${workerId}`;
    await tx`update sync_cursors set last_attempt_at=now(),last_error_at=now(),last_error_code=${code},last_error_message=${message.slice(0, 500)},consecutive_failures=consecutive_failures+1,updated_at=now() where owner_id=${job.ownerId} and canvas_account_id=${job.canvasAccountId} and resource_type=${job.kind}`;
  });
}

// ---------------------------------------------------------------- direct Canvas API
// The hosted browser is login-only. Sync, keepalives and recovery checks use
// the server-side cookie client; nothing here provisions or restores a browser.

type ProbeTarget = { id: string; canvas_account_id: string | null; canvas_origin: string };
type ProbeResult = { ok: boolean; authRequired: boolean } | "unreachable";

function canvasClient(ownerId: string, hostedSessionId: string, canvasOrigin: string, options: { requireActive?: boolean } = {}) {
  return new CanvasSessionClient({ ownerId, canvasOrigin, store: sqlEncryptedStateStore((work) => tenant(ownerId, work), ownerId, hostedSessionId, options) });
}

/** Persist pending cookie rotations, then write one value-free health row for this client's calls. */
async function recordHealth(ownerId: string, hostedSessionId: string, client: CanvasSessionClient, kind: HealthKind) {
  await client.flush().catch(() => undefined);
  const row = healthEventRow(client.stats(), { ownerId, hostedSessionId, kind });
  if (!row) return;
  await tenant(ownerId, (tx) => insertHealthEvent(tx, row)).catch((error) => console.error("session-health insert failed:", error instanceof Error ? error.message : "unknown"));
  console.log(JSON.stringify({ event: "canvas_session_health", kind, session: hostedSessionId.slice(0, 8), outcome: row.outcome, status: row.http_status, calls: row.call_count,
    ok: row.ok_count, authRequired: row.auth_required_count, errors: row.error_count, sessionCookieReissued: row.session_cookie_reissued, rotated: row.cookie_names_rotated }));
}

/**
 * Canvas rejected the captured cookies (401, redirect to login, HTML login
 * page) or the jar is unreadable: the user must sign in again. No browser
 * restore. `from` guards which state may transition.
 */
async function markCanvasSessionExpired(tx: postgres.TransactionSql, ownerId: string, hostedSessionId: string, canvasAccountId: string | null, from: "active" | "stranded" = "active") {
  const updated = await tx<{ id: string }[]>`update hosted_browser_sessions set status='auth_required',failure_code='CANVAS_SESSION_EXPIRED',last_auth_check_at=now(),updated_at=now()
    where owner_id=${ownerId} and id=${hostedSessionId} and revoked_at is null
      and (${from === "active"} and status='active' or ${from === "stranded"} and status='auth_required' and failure_code=${STRANDED_FAILURE_CODE}) returning id`;
  if (updated.length && canvasAccountId) await tx`update sync_policies set status='paused',last_error_at=now(),last_error_code='CANVAS_SESSION_EXPIRED',updated_at=now()
    where owner_id=${ownerId} and canvas_account_id=${canvasAccountId}`;
  if (updated.length) console.log(JSON.stringify({ event: "canvas_session_expired", session: hostedSessionId.slice(0, 8) }));
}

/** GET / (HTML dashboard page) with the stored cookies; logs a `page-keepalive` health event. */
async function touchSessionPage(ownerId: string, target: ProbeTarget): Promise<ProbeResult & { touch?: { status: number; sessionCookieReissued: boolean; rotatedNames: string[] } }> {
  const client = canvasClient(ownerId, target.id, target.canvas_origin);
  try {
    const touch = await client.touchSession();
    return { ok: touch.status >= 200 && touch.status < 300 && !touch.authRequired, authRequired: touch.authRequired, touch };
  } catch (error) {
    return error instanceof BridgeError && error.code === "CANVAS_SESSION_EXPIRED" ? { ok: false, authRequired: true } : "unreachable";
  } finally { await recordHealth(ownerId, target.id, client, "page-keepalive"); }
}

/** GET /api/v1/users/self with the stored cookies. An unreadable/missing jar counts as an auth rejection. */
async function probeSession(ownerId: string, target: ProbeTarget, kind: HealthKind): Promise<ProbeResult> {
  const client = canvasClient(ownerId, target.id, target.canvas_origin, { requireActive: kind !== "restore-check" });
  try {
    const result = await client.request({ method: "GET", path: "/api/v1/users/self" });
    return { ok: result.ok, authRequired: result.authRequired };
  } catch (error) {
    return error instanceof BridgeError && error.code === "CANVAS_SESSION_EXPIRED" ? { ok: false, authRequired: true } : "unreachable";
  } finally { await recordHealth(ownerId, target.id, client, kind); }
}

/** Keep each active session's sliding Canvas expiry alive when nothing else has called Canvas recently. */
async function runKeepalives(ownerId: string) {
  const sessions = await tenant(ownerId, (tx) => tx<(ProbeTarget & { last_call_at: Date | null; last_keepalive_kind: string | null })[]>`
    select s.id,s.canvas_account_id,p.canvas_origin,
      (select max(e.at) from canvas_session_health_events e where e.owner_id=s.owner_id and e.hosted_session_id=s.id) last_call_at,
      (select e.kind from canvas_session_health_events e where e.owner_id=s.owner_id and e.hosted_session_id=s.id and e.kind in ('keepalive','page-keepalive') order by e.at desc limit 1) last_keepalive_kind
    from hosted_browser_sessions s join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
    where s.owner_id=${ownerId} and s.status='active' and s.revoked_at is null and s.encrypted_state_nonce is not null
      and not exists(select 1 from sync_jobs j where j.owner_id=s.owner_id and j.hosted_session_id=s.id and j.status in ('leased','running'))`);
  for (const session of sessions) {
    if (!keepaliveDue(session.last_call_at, new Date(), KEEPALIVE_MINUTES)) continue;
    const kind = nextKeepaliveKind(session.last_keepalive_kind, PAGE_KEEPALIVE);
    const probe = kind === "page-keepalive" ? await touchSessionPage(ownerId, session) : await probeSession(ownerId, session, "keepalive");
    if (probe !== "unreachable" && probe.authRequired) await tenant(ownerId, (tx) => markCanvasSessionExpired(tx, ownerId, session.id, session.canvas_account_id));
    else if (probe !== "unreachable" && probe.ok) await tenant(ownerId, (tx) => tx`update hosted_browser_sessions set last_auth_check_at=now() where owner_id=${ownerId} and id=${session.id} and status='active'`);
  }
}

/**
 * Idempotent recovery of sessions stranded as auth_required/BROWSER_SESSION_NOT_FOUND
 * by the old browser-backed sync while their cookie jar is intact (see
 * lib/canvas/session-recovery.ts). Success reactivates the session, resumes
 * its policies and resets queued jobs; a Canvas rejection marks it
 * CANVAS_SESSION_EXPIRED. Either way failure_code changes, so it runs once.
 */
async function recoverStrandedSessions(ownerId: string) {
  const candidates = await tenant(ownerId, (tx) => tx<(ProbeTarget & { status: string; failure_code: string | null; last_auth_check_at: Date | null; has_state: boolean; monitor_live: boolean })[]>`
    select s.id,s.canvas_account_id,p.canvas_origin,s.status,s.failure_code,s.last_auth_check_at,(s.encrypted_state_nonce is not null) has_state,
      exists(select 1 from interactive_session_monitors m where m.owner_id=s.owner_id and m.hosted_session_id=s.id and m.status in ('queued','leased')) monitor_live
    from hosted_browser_sessions s join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
    where s.owner_id=${ownerId} and s.status='auth_required' and s.failure_code=${STRANDED_FAILURE_CODE} and s.revoked_at is null`);
  for (const candidate of candidates) {
    const action = browserLostRecoveryAction({ status: candidate.status, failureCode: candidate.failure_code, hasEncryptedState: candidate.has_state, hasCanvasAccount: Boolean(candidate.canvas_account_id),
      monitorLive: candidate.monitor_live, revoked: false, lastAuthCheckAt: candidate.last_auth_check_at }, new Date());
    if (action !== "probe") continue;
    const outcome = recoveryOutcome(await probeSession(ownerId, candidate, "restore-check"));
    await tenant(ownerId, async (tx) => {
      if (outcome === "activate") {
        const updated = await tx<{ id: string }[]>`update hosted_browser_sessions set status='active',failure_code=null,last_auth_check_at=now(),updated_at=now()
          where owner_id=${ownerId} and id=${candidate.id} and status='auth_required' and failure_code=${STRANDED_FAILURE_CODE} returning id`;
        if (updated.length && candidate.canvas_account_id) {
          await tx`update sync_policies set status='active',next_run_at=now(),last_error_at=null,last_error_code=null,updated_at=now() where owner_id=${ownerId} and canvas_account_id=${candidate.canvas_account_id}`;
          await tx`update sync_jobs set attempt=0,run_after=now(),error_code=null,error_message=null,updated_at=now() where owner_id=${ownerId} and canvas_account_id=${candidate.canvas_account_id} and status='queued'`;
        }
      } else if (outcome === "expire") await markCanvasSessionExpired(tx, ownerId, candidate.id, candidate.canvas_account_id, "stranded");
      else await tx`update hosted_browser_sessions set last_auth_check_at=now() where owner_id=${ownerId} and id=${candidate.id} and failure_code=${STRANDED_FAILURE_CODE}`;
    });
    console.log(JSON.stringify({ event: "canvas_session_recovery", session: candidate.id.slice(0, 8), outcome }));
  }
}

async function runJob(job: Job) {
  const timer = setInterval(() => void heartbeat(job).catch(() => undefined), 40_000);
  const client = canvasClient(job.ownerId, job.hostedSessionId, job.canvasOrigin);
  try {
    await heartbeat(job);
    const result = await executeCanvasSyncJob({ kind: job.kind, api: client, scope: job.ownerId, onBreakdown: (breakdown) => console.log(JSON.stringify({ event: "canvas_error_breakdown", kind: job.kind, session: job.hostedSessionId.slice(0, 8), breakdown })) });
    if (result.ok) await complete(job, result.records);
    else await fail(job, result.authExpired ? "CANVAS_SESSION_EXPIRED" : result.rateLimited ? "RATE_LIMITED" : `HTTP_${result.status}`, `Canvas sync returned HTTP ${result.status}`, { authExpired: result.authExpired, retryAfterMs: result.retryAfterMs });
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : "WORKER_ERROR";
    await fail(job, code, error instanceof Error ? error.message : "Unknown worker error", { authExpired: code === "CANVAS_SESSION_EXPIRED" });
  } finally {
    clearInterval(timer);
    await recordHealth(job.ownerId, job.hostedSessionId, client, "sync");
  }
}

async function main() {
  console.log(`sync-worker ${workerId} started (concurrency=${concurrency})`);
  const active = new Set<Promise<void>>();
  const monitors = new Set<Promise<void>>();
  let loopFailures = 0;
  while (!stopping) {
    // One loop iteration must never end the worker: a transient DB error (e.g.
    // postgres not accepting connections yet after a host reboot, where Docker
    // ignores depends_on ordering) used to reject main() and, under `tsx watch`,
    // leave the container "Up" with no worker running. Back off and retry instead.
    try {
      await loopOnce(active, monitors);
      if (loopFailures) console.log(`sync-worker loop recovered after ${loopFailures} failure(s)`);
      loopFailures = 0;
    } catch (error) {
      loopFailures += 1;
      const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(loopFailures - 1, 5));
      console.error(`sync-worker loop failed (${loopFailures}), retrying in ${delayMs}ms:`, error instanceof Error ? error.message : "unknown");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await Promise.allSettled([...active, ...monitors]); await sql.end({ timeout: 5 });
}

async function loopOnce(active: Set<Promise<void>>, monitors: Set<Promise<void>>) {
  {
    const owners = await sql<{ id: string }[]>`select id from users where status='active' order by id`;
    if (Date.now() >= nextReconcileAt) {
      nextReconcileAt = Date.now() + 30_000;
      await reconcileBrowserOwnership(owners).catch((error) => console.error("browser-reconcile failed:", error instanceof Error ? error.message : "unknown"));
    }
    if (Date.now() >= nextSessionHealthAt) {
      // Direct-API session health: one-time recovery of browser-stranded
      // sessions (runs on the first loop after start), then keepalives.
      nextSessionHealthAt = Date.now() + 60_000;
      for (const owner of owners) {
        await recoverStrandedSessions(owner.id).catch((error) => console.error("session-recovery failed:", error instanceof Error ? error.message : "unknown"));
        await runKeepalives(owner.id).catch((error) => console.error("session-keepalive failed:", error instanceof Error ? error.message : "unknown"));
      }
    }
    for (const owner of owners) { await bootstrapAuthMonitors(owner.id); await bootstrapPolicies(owner.id); await scheduleDue(owner.id); }
    for (const owner of owners) {
      if (monitors.size < MONITOR_CONCURRENCY) {
        const monitor = await claimAuthMonitor(owner.id);
        if (monitor) { lastMonitorClaimAt = Date.now(); const task = runAuthMonitor(monitor).catch((error) => console.error("auth-monitor task failed:", error instanceof Error ? error.message : "unknown")).finally(() => monitors.delete(task)); monitors.add(task); continue; }
      }
      if (active.size >= concurrency) continue;
      const job = await claimNext(owner.id);
      if (job) { const task = runJob(job).catch((error) => console.error(`sync job ${job.kind} failed outside its handler:`, error instanceof Error ? error.message : "unknown")).finally(() => active.delete(task)); active.add(task); }
    }
    const interactiveLive = Date.now() - lastMonitorClaimAt < 15_000;
    await new Promise((resolve) => setTimeout(resolve, interactiveLive ? Math.min(pollMs, 1000) : pollMs));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });
// Exit for real on a fatal error: open postgres connections would otherwise keep
// the process alive doing nothing, so the restart policy never kicks in.
void main().then(() => process.exit(0), (error) => { console.error("sync-worker stopped:", error instanceof Error ? error.message : error); process.exit(1); });
