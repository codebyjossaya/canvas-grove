import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTenantSql } from "@/lib/db";
import { QuizServiceError, getAttemptTime, getCurrentAttempt, getQuizPreflight, saveAnswer, submitAttempt } from "@/lib/quizzes/service";
import { canPropose } from "./categories";
import { quizClassification, sessionAllows } from "./action-policy";
import { StageError, cancelConnectionAction, connectionAction, connectionActions, connectionOf, recordImmediate, stageAction, type Executor, type Preview, type StageOutcome } from "./actions";
import { EXECUTABLE_TOOLS, executorFor } from "./executors";
import { auditQuiz, endSession, loadQuiz, openSession, type ConnectionCols, type QuizRecord } from "./quiz-core";
import { fitItems, untrusted } from "./content";
import { formatQuizQuestions } from "./quiz-format";
import { fromNativeBundle, isOneQuestionAtATime, readCurrentAttempt } from "./quiz-read";
import { BULK_MAX_ENTRIES, bulkSummary, planBulkAnswers, runBulkSave } from "./quiz-bulk";
import type { BearerAuth } from "./store";

// Phase-2 tools. Writes are staged for approval in Grove unless the connection's auto mode covers
// them; planner tools are Grove-local and immediate. Quizzes: approval at ENTRY only, with
// technical eligibility re-checked on every call (never relaxed by auto mode or sessions).

const READ = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true } as const;
const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false } as const;
const LOCAL_WRITE = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false } as const;
type Data = Record<string, unknown>;

class ToolError extends Error { constructor(public code: string, message: string) { super(message); } }
const ok = (data: Data): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const err = (code: string, message: string): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify({ code, message }) }], structuredContent: { code, message }, isError: true });

const quizRef = z.string().min(1).max(64).describe("Quiz id from list_quizzes (Canvas quiz id or Grove's id)");
const idemKey = z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/).optional().describe("Optional key; repeating it returns the same staged action instead of a new one");
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

function wrap(name: string, auth: BearerAuth, work: () => Promise<Data>) {
  return async (): Promise<CallToolResult> => {
    const started = Date.now();
    let status = "ok";
    try { return ok(await work()); }
    catch (error) {
      if (error instanceof ToolError || error instanceof StageError || error instanceof QuizServiceError) { status = error.code; return err(error.code, error.message); }
      status = "error";
      return err("TOOL_FAILED", "Grove could not complete this request right now.");
    } finally {
      console.info(JSON.stringify({ event: "mcp_tool", tool: name, ownerId: auth.ctx.ownerId, status, ms: Date.now() - started }));
    }
  };
}

const connCols = (auth: BearerAuth): ConnectionCols => {
  const c = connectionOf(auth);
  return { tokenId: c.kind === "token" ? c.id : null, grantId: c.kind === "grant" ? c.id : null, clientName: c.clientName };
};

const stageResult = (outcome: StageOutcome): Data => ({
  actionId: outcome.action.id, status: outcome.action.status, preview: { title: outcome.action.title, summary: outcome.action.summary, ...outcome.action.preview },
  expiresAt: outcome.action.expiresAt, decidedBy: outcome.action.decidedBy, ...(outcome.action.result ? { result: outcome.action.result } : {}),
  replay: outcome.replay, ...(outcome.autoNote ? { note: outcome.autoNote } : {}),
  ...(outcome.action.status === "awaiting_approval" ? { next: "Ask the user to approve this in Canvas Grove (Approvals), then check it with get_action." } : {}),
});

// ------------------------------------------------------------------ quiz gate (every call)

/** Loads the quiz fresh and enforces the technical gate. Blocked calls are audited; no question text is ever returned. */
async function gate(auth: BearerAuth, tool: string, ref: string): Promise<QuizRecord> {
  const { quiz, eligibility } = await loadQuiz(auth.ctx.ownerId, ref);
  if (!quiz) throw new ToolError("QUIZ_NOT_FOUND", `No quiz "${ref}". Use list_quizzes to see quiz ids.`);
  if (!eligibility.eligible) {
    await auditQuiz(auth.ctx.ownerId, connCols(auth), tool, "blocked:not_eligible");
    throw new ToolError("QUIZ_NOT_ELIGIBLE", eligibility.reason);
  }
  return quiz;
}

/** Gate + an open session for this connection and quiz, verified against Canvas's current attempt. */
async function sessionFor(auth: BearerAuth, tool: string, ref: string) {
  const quiz = await gate(auth, tool, ref);
  const conn = connCols(auth);
  const session = await openSession(auth.ctx.ownerId, conn, quiz.id);
  const pre = sessionAllows(session, quiz.id);
  if (!pre.ok) { await auditQuiz(auth.ctx.ownerId, conn, tool, `blocked:${pre.code}`); throw new ToolError(pre.code, pre.message); }
  const time = await getAttemptTime(auth.ctx, quiz.id).catch((error) => {
    if (error instanceof QuizServiceError && error.code === "NO_ACTIVE_ATTEMPT") return null;
    throw error;
  });
  const live = sessionAllows(session, quiz.id, time ? { submissionId: String(time.attempt.id), attempt: time.attempt.attempt } : { submissionId: "", attempt: -1 });
  if (!live.ok) {
    await endSession(auth.ctx.ownerId, session!.id);
    await auditQuiz(auth.ctx.ownerId, conn, tool, `blocked:${time ? live.code : "attempt_not_active"}`);
    throw new ToolError(time ? live.code : "QUIZ_SESSION_ENDED", time ? live.message : "The approved attempt is no longer active. A new attempt needs a new approval.");
  }
  return { quiz, session: session!, conn };
}

// ------------------------------------------------------------------ staged-only tools (hidden while NOT_SUPPORTED_YET)

export const submitAssignmentArgs = {
  assignment: z.string().min(1).max(64).describe("Canvas assignment id or Grove's id"),
  type: z.enum(["online_text_entry", "online_url", "online_upload"]),
  body: z.string().min(1).max(50_000).optional().describe("Text for online_text_entry"),
  url: z.string().url().max(2000).optional().describe("URL for online_url"),
  canvasFileIds: z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(10).optional().describe("Files already synced in Grove, for online_upload"),
  idempotencyKey: idemKey,
};

export async function stageSubmitAssignment(auth: BearerAuth, args: z.infer<z.ZodObject<typeof submitAssignmentArgs>>, executor: Executor = executorFor("submit_assignment")) {
  const owner = auth.ctx.ownerId;
  const [a] = await withTenantSql(owner, (tx) => tx<{ id: string; name: string; due_at: string | null; lock_at: string | null; submission_types: string[]; course_name: string; canvas_course_id: string }[]>`
    select a.id, a.name, a.due_at, a.lock_at, a.submission_types, c.name as course_name, c.canvas_course_id from assignments a join courses c on c.owner_id = a.owner_id and c.id = a.course_id
    where a.owner_id = ${owner} and a.deleted_at is null and c.deleted_at is null and (a.canvas_assignment_id = ${args.assignment} or a.id::text = ${args.assignment.toLowerCase()}) limit 1`);
  if (!a) throw new ToolError("NOT_FOUND", "No such assignment.");
  if (!a.submission_types.includes(args.type)) throw new ToolError("SUBMISSION_TYPE_NOT_ALLOWED", `This assignment accepts: ${a.submission_types.join(", ") || "no online submissions"}.`);
  if (a.lock_at && new Date(a.lock_at).getTime() <= Date.now()) throw new ToolError("TARGET_LOCKED", "This assignment is locked.");
  const content = args.type === "online_text_entry" ? args.body : args.type === "online_url" ? args.url : args.canvasFileIds?.join(", ");
  if (!content) throw new ToolError("INVALID_ARGUMENTS", "Provide body, url or canvasFileIds matching the submission type.");
  if (args.type === "online_upload") {
    const files = await withTenantSql(owner, (tx) => tx`select canvas_file_id from course_files where owner_id = ${owner} and deleted_at is null and canvas_file_id in ${tx(args.canvasFileIds!)}`);
    if (files.length !== new Set(args.canvasFileIds).size) throw new ToolError("FILE_NOT_IN_GROVE", "Uploads may only use files already synced in Grove.");
  }
  const preview: Preview = {
    title: `Submit "${a.name}"`, summary: `${auth.clientName} wants to submit this assignment for you.`,
    lines: [{ label: "Assignment", value: a.name }, { label: "Course", value: a.course_name }, { label: "Due", value: iso(a.due_at) ?? "No due date" }, { label: "Type", value: args.type.replaceAll("_", " ") }, { label: "Content", value: content.length > 600 ? `${content.slice(0, 600)}…` : content }],
    warning: "Submitting is final in Canvas and may count as an attempt.",
  };
  return stageAction(auth, { tool: "submit_assignment", args: { assignmentId: a.id, type: args.type, body: args.body ?? null, url: args.url ?? null, canvasFileIds: args.canvasFileIds ?? null }, preview, idempotencyKey: args.idempotencyKey }, executor);
}

export const replyArgs = { courseId: z.string().regex(/^\d{1,20}$/), topicId: z.string().regex(/^\d{1,20}$/), message: z.string().min(1).max(10_000), idempotencyKey: idemKey };
export async function stageDiscussionReply(auth: BearerAuth, args: z.infer<z.ZodObject<typeof replyArgs>>, executor: Executor = executorFor("reply_to_discussion")) {
  const preview: Preview = { title: "Post a discussion reply", summary: `${auth.clientName} wants to post this reply as you.`, lines: [{ label: "Course", value: args.courseId }, { label: "Topic", value: args.topicId }, { label: "Message", value: args.message.slice(0, 1000) }], warning: "Classmates and instructors will see this reply." };
  return stageAction(auth, { tool: "reply_to_discussion", args: { courseId: args.courseId, topicId: args.topicId, message: args.message }, preview, idempotencyKey: args.idempotencyKey }, executor);
}

export const messageArgs = { conversationId: z.string().regex(/^\d{1,20}$/).describe("Existing Canvas conversation to reply in"), body: z.string().min(1).max(10_000), idempotencyKey: idemKey };
export async function stageMessage(auth: BearerAuth, args: z.infer<z.ZodObject<typeof messageArgs>>, executor: Executor = executorFor("send_message")) {
  const preview: Preview = { title: "Send a Canvas message", summary: `${auth.clientName} wants to send this message as you.`, lines: [{ label: "Conversation", value: args.conversationId }, { label: "Message", value: args.body.slice(0, 1000) }], warning: "The recipients will see this message from you." };
  return stageAction(auth, { tool: "send_message", args: { conversationId: args.conversationId, body: args.body }, preview, idempotencyKey: args.idempotencyKey }, executor);
}

// ------------------------------------------------------------------ quiz entry staging

export async function stageQuizStart(auth: BearerAuth, ref: string, idempotencyKey?: string, executor: Executor = executorFor("start_quiz_attempt")): Promise<Data> {
  const quiz = await gate(auth, "start_quiz_attempt", ref);
  const classification = quizClassification(quiz.quiz_type);
  const existing = await openSession(auth.ctx.ownerId, connCols(auth), quiz.id);
  if (existing && sessionAllows(existing, quiz.id).ok) return { status: "session_open", quizId: quiz.id, attempt: existing.attempt, expiresAt: iso(existing.expires_at), next: "Use get_quiz_question for this quiz." };
  const preview: Preview = {
    title: `Start ${classification.label.toLowerCase()}: ${quiz.title}`,
    summary: `Let ${auth.clientName} take this ${classification.label.toLowerCase()}: it can read the questions, answer them and submit this attempt.`,
    lines: [
      { label: "Quiz", value: quiz.title ?? "Quiz" }, { label: "Course", value: quiz.course_name },
      { label: "Type", value: classification.label },
      { label: "Points", value: quiz.points_possible == null ? "Not specified" : String(Number(quiz.points_possible)) },
      { label: "Attempts allowed", value: quiz.allowed_attempts == null || quiz.allowed_attempts === -1 ? "Unlimited" : String(quiz.allowed_attempts) },
      { label: "Time limit", value: quiz.time_limit_minutes ? `${quiz.time_limit_minutes} minutes` : "None" },
      { label: "Questions", value: quiz.question_count == null ? "Unknown" : String(quiz.question_count) },
    ],
    warning: classification.graded
      ? "This is a graded Canvas assessment. Starting uses an attempt and may start a timer; its answers and submission may affect your course grade. This approval covers one attempt only."
      : "Starting uses a Canvas attempt and may start a timer. The approval covers this one attempt only.",
  };
  return stageResult(await stageAction(auth, { tool: "start_quiz_attempt", args: { quizId: quiz.id }, preview, idempotencyKey }, executor));
}

// ------------------------------------------------------------------ registration

export function registerPhase2Tools(server: McpServer, auth: BearerAuth) {
  const owner = auth.ctx.ownerId;
  const writable = canPropose(auth.scopes);

  server.registerTool("get_quiz", {
    title: "Get quiz",
    description: "Quiz rules (type, grading, points, time limit, attempts), whether Grove can run it, and any open quiz session. Supports practice quizzes, graded quizzes, surveys and graded surveys; never returns questions.",
    inputSchema: { quiz: quizRef }, annotations: READ,
  }, ({ quiz }) => wrap("get_quiz", auth, async () => {
    const { quiz: q, eligibility } = await loadQuiz(owner, quiz);
    if (!q) throw new ToolError("QUIZ_NOT_FOUND", `No quiz "${quiz}".`);
    const pre = await getQuizPreflight(auth.ctx, q.id).catch(() => null);
    const session = writable ? await openSession(owner, connCols(auth), q.id) : null;
    return {
      quizId: q.id, canvasQuizId: q.canvas_quiz_id, title: q.title, courseId: q.canvas_course_id, course: q.course_name, type: q.quiz_type, engine: q.engine, ...quizClassification(q.quiz_type),
      pointsPossible: q.points_possible == null ? null : Number(q.points_possible), timeLimitMinutes: q.time_limit_minutes, allowedAttempts: q.allowed_attempts,
      questionCount: q.question_count, dueAt: iso(q.due_at), lockAt: iso(q.lock_at),
      status: pre?.availability.status ?? null, attemptsUsed: pre?.availability.attemptsUsed ?? null, attemptsRemaining: pre?.availability.attemptsRemaining ?? null,
      eligibleForAssistant: eligibility.eligible, ...(eligibility.eligible ? {} : { ineligibleReason: eligibility.reason }),
      session: session && sessionAllows(session, q.id).ok ? { attempt: session.attempt, expiresAt: iso(session.expires_at) } : null,
    };
  })());

  server.registerTool("get_quiz_result", {
    title: "Get quiz result",
    description: "The latest recorded attempt for a quiz: state, score and finish time. No questions or answers.",
    inputSchema: { quiz: quizRef }, annotations: READ,
  }, ({ quiz }) => wrap("get_quiz_result", auth, async () => {
    const { quiz: q } = await loadQuiz(owner, quiz);
    if (!q) throw new ToolError("QUIZ_NOT_FOUND", `No quiz "${quiz}".`);
    const rows = await withTenantSql(owner, (tx) => tx<{ attempt: number; workflow_state: string; score: unknown; kept_score: unknown; finished_at: string | null; started_at: string | null }[]>`
      select attempt, workflow_state, score, kept_score, finished_at, started_at from quiz_attempts where owner_id = ${owner} and quiz_id = ${q.id} order by attempt desc limit 5`);
    return { quizId: q.id, title: q.title, pointsPossible: q.points_possible == null ? null : Number(q.points_possible),
      attempts: rows.map((r) => ({ attempt: r.attempt, state: r.workflow_state, score: r.score == null ? null : Number(r.score), keptScore: r.kept_score == null ? null : Number(r.kept_score), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at) })) };
  })());

  server.registerTool("list_planner_items", {
    title: "List planner items",
    description: "The user's Grove planner items (notes, to-dos and synced Canvas items) with ids for complete_planner_item.",
    inputSchema: { status: z.enum(["todo", "completed", "all"]).default("todo"), limit: z.number().int().min(1).max(200).default(50) }, annotations: READ,
  }, ({ status, limit }) => wrap("list_planner_items", auth, async () => {
    const rows = await withTenantSql(owner, (tx) => tx<{ id: string; kind: string; source: string; title: string; status: string; due_at: string | null; course_name: string | null }[]>`
      select p.id, p.kind, p.source::text as source, p.title, p.status::text as status, p.due_at, c.name as course_name from planner_items p left join courses c on c.owner_id = p.owner_id and c.id = p.course_id
      where p.owner_id = ${owner} and p.deleted_at is null ${status === "all" ? tx`` : status === "todo" ? tx`and p.status in ('todo', 'in_progress')` : tx`and p.status = 'completed'`}
      order by p.due_at asc nulls last, p.created_at desc limit ${limit}`);
    const items = rows.map((r) => ({ itemId: r.id, kind: r.kind, source: r.source, title: untrusted(r.title), status: r.status, dueAt: iso(r.due_at), course: r.course_name }));
    return fitItems(items, (slice, cut) => ({ count: slice.length, truncated: cut, items: slice }));
  })());

  if (!writable) return;

  server.registerTool("save_planner_note", {
    title: "Save planner note",
    description: "Add a note or to-do to the user's Grove planner. Grove-local and immediate (nothing is sent to Canvas).",
    inputSchema: {
      title: z.string().min(1).max(200), notes: z.string().max(4000).optional(), kind: z.enum(["note", "todo"]).default("todo"),
      dueAt: z.string().datetime({ offset: true }).optional(), course: z.string().min(1).max(64).optional().describe("Canvas course id or Grove's id"),
    }, annotations: LOCAL_WRITE,
  }, (args) => wrap("save_planner_note", auth, async () => {
    const row = await withTenantSql(owner, async (tx) => {
      const [course] = args.course ? await tx<{ id: string }[]>`select id from courses where owner_id = ${owner} and deleted_at is null and (canvas_course_id = ${args.course} or id::text = ${args.course.toLowerCase()}) limit 1` : [];
      if (args.course && !course) throw new ToolError("NOT_FOUND", "No such course.");
      const [created] = await tx<{ id: string }[]>`insert into planner_items (owner_id, course_id, source, kind, title, notes, due_at)
        values (${owner}, ${course?.id ?? null}, 'app', ${args.kind}, ${args.title}, ${args.notes ?? null}, ${args.dueAt ?? null}) returning id`;
      return created;
    });
    await recordImmediate(auth, "save_planner_note", { title: `Saved ${args.kind}: ${args.title.slice(0, 80)}`, summary: "Added to your Grove planner.", lines: [{ label: "Title", value: args.title }] }, { itemId: row.id }, { ok: true, message: "Saved to the Grove planner." });
    return { saved: true, itemId: row.id };
  })());

  server.registerTool("complete_planner_item", {
    title: "Complete planner item",
    description: "Mark a Grove planner item done. Grove-local and immediate (Canvas is not changed). Canvas-synced items may be reset by the next sync.",
    inputSchema: { itemId: z.string().uuid() }, annotations: LOCAL_WRITE,
  }, ({ itemId }) => wrap("complete_planner_item", auth, async () => {
    const [row] = await withTenantSql(owner, (tx) => tx<{ id: string; title: string; source: string }[]>`update planner_items set status = 'completed', completed_at = now(), updated_at = now()
      where owner_id = ${owner} and id = ${itemId} and deleted_at is null returning id, title, source::text as source`);
    if (!row) throw new ToolError("NOT_FOUND", "No such planner item.");
    await recordImmediate(auth, "complete_planner_item", { title: `Marked done: ${row.title.slice(0, 80)}`, summary: "Marked done in your Grove planner.", lines: [{ label: "Item", value: row.title }] }, { itemId }, { ok: true, message: "Marked done in Grove." });
    return { completed: true, itemId: row.id, source: row.source };
  })());

  server.registerTool("list_actions", {
    title: "List my proposed actions",
    description: "Actions this connection proposed, newest first, with their status (awaiting_approval, done, failed, rejected, expired, cancelled).",
    inputSchema: { status: z.enum(["awaiting_approval", "approved", "rejected", "executing", "done", "failed", "expired", "cancelled"]).optional(), limit: z.number().int().min(1).max(50).default(20) }, annotations: READ,
  }, ({ status, limit }) => wrap("list_actions", auth, async () => {
    const actions = await connectionActions(auth, status ?? null, limit);
    return { count: actions.length, actions };
  })());

  server.registerTool("get_action", {
    title: "Get proposed action",
    description: "Status and result of one action this connection proposed.",
    inputSchema: { actionId: z.string().uuid() }, annotations: READ,
  }, ({ actionId }) => wrap("get_action", auth, async () => {
    const action = await connectionAction(auth, actionId);
    if (!action) throw new ToolError("NOT_FOUND", "No such action for this connection.");
    return { action };
  })());

  server.registerTool("cancel_action", {
    title: "Cancel proposed action",
    description: "Withdraw one of this connection's actions that is still awaiting approval. For a started quiz, ends that quiz session.",
    inputSchema: { actionId: z.string().uuid() }, annotations: { ...LOCAL_WRITE, idempotentHint: true },
  }, ({ actionId }) => wrap("cancel_action", auth, async () => {
    const action = await cancelConnectionAction(auth, actionId);
    if (!action) throw new ToolError("NOT_FOUND", "No such action for this connection.");
    return { action };
  })());

  server.registerTool("start_quiz_attempt", {
    title: "Start quiz",
    description: "Ask the user to let you take a supported Classic Quiz, including a graded quiz or survey. Needs approval in Grove unless auto mode covers quiz entry. Once approved, get_quiz_question, answer_quiz_question and submit_quiz_attempt work for that one attempt without further approval. Technically unsupported, proctored and New Quizzes are refused.",
    inputSchema: { quiz: quizRef, idempotencyKey: idemKey }, annotations: WRITE,
  }, ({ quiz, idempotencyKey }) => wrap("start_quiz_attempt", auth, () => stageQuizStart(auth, quiz, idempotencyKey))());

  server.registerTool("get_quiz_question", {
    title: "Get quiz questions",
    description: "The WHOLE approved quiz attempt in one call (default; pass questionId only to re-read one question): every question drawn for the attempt, including question-group picks, with type, points, group, text (math as LaTeX between \\( and \\), blanks and dropdowns as [blank N] / [dropdown N: …] markers), answer options, saved answers and the time left. Ones Grove cannot save have answerable=false and a note to answer them in Canvas. A very large quiz is split: truncated=true with nextCursor to fetch the rest.",
    inputSchema: {
      quiz: quizRef, questionId: z.string().regex(/^\d{1,20}$/).optional().describe("Only this question (omit to get the whole quiz)"),
      cursor: z.string().regex(/^\d{1,4}$/).optional().describe("nextCursor from a truncated result"),
    }, annotations: READ,
  }, ({ quiz, questionId, cursor }) => wrap("get_quiz_question", auth, async () => {
    // Read-only: one attempt-state read, then question pages and timer in parallel (no separate timer pre-check).
    const q = await gate(auth, "get_quiz_question", quiz);
    const conn = connCols(auth);
    const session = await openSession(owner, conn, q.id);
    const pre = sessionAllows(session, q.id);
    if (!pre.ok) { await auditQuiz(owner, conn, "get_quiz_question", `blocked:${pre.code}`); throw new ToolError(pre.code, pre.message); }
    const read = await (isOneQuestionAtATime(q) ? getCurrentAttempt(auth.ctx, q.id).then(fromNativeBundle) : readCurrentAttempt(auth.ctx, q)).catch(async (error) => {
      if (!(error instanceof QuizServiceError && error.code === "NO_ACTIVE_ATTEMPT")) throw error;
      await endSession(owner, session!.id);
      await auditQuiz(owner, conn, "get_quiz_question", "blocked:attempt_not_active");
      throw new ToolError("QUIZ_SESSION_ENDED", "The approved attempt is no longer active. A new attempt needs a new approval.");
    });
    const live = sessionAllows(session, q.id, { submissionId: read.submissionId, attempt: read.attempt });
    if (!live.ok) { await endSession(owner, session!.id); await auditQuiz(owner, conn, "get_quiz_question", `blocked:${live.code}`); throw new ToolError(live.code, live.message); }
    const selected = questionId ? read.questions.filter((item) => item.id === questionId) : read.questions;
    if (questionId && !selected.length) throw new ToolError("QUESTION_NOT_FOUND", "That question is not part of this attempt.");
    await auditQuiz(owner, conn, "get_quiz_question", "ok");
    const all = formatQuizQuestions(selected);
    const offset = cursor ? Math.min(Number(cursor), all.length) : 0;
    const questions = all.slice(offset);
    const unanswerable = all.filter((item) => !item.answerable).length;
    return fitItems(questions, (slice, cut) => ({ quizId: q.id, attempt: read.attempt, total: all.length, offset, count: slice.length, truncated: cut, ...(cut ? { nextCursor: String(offset + slice.length) } : {}), questions: slice, timing: read.timing,
      ...(unanswerable ? { note: `${unanswerable} question(s) must be answered in Canvas (answerable=false). Tell the user before submitting.` } : {}),
      ...(read.incomplete ? { incomplete: read.incomplete } : {}),
      answerFormat: "multiple_choice/true_false: option id; multiple_answers: array of option ids; fill_in_multiple_blanks: object of blanks[].id -> text; short_answer/essay: text; numerical/calculated: number" }));
  })());

  server.registerTool("answer_quiz_question", {
    title: "Answer quiz question",
    description: "Save an answer for one question of the approved quiz attempt.",
    inputSchema: { quiz: quizRef, questionId: z.string().regex(/^\d{1,20}$/), answer: z.union([z.string().max(16_384), z.number(), z.array(z.number().int()).max(50), z.record(z.string().min(1).max(128), z.string().max(16_384))]).describe("See answerFormat in get_quiz_question") }, annotations: { ...WRITE, idempotentHint: true },
  }, ({ quiz, questionId, answer }) => wrap("answer_quiz_question", auth, async () => {
    const { quiz: q, conn } = await sessionFor(auth, "answer_quiz_question", quiz);
    const saved = await saveAnswer(auth.ctx, q.id, questionId, answer, undefined, Date.now());
    await auditQuiz(owner, conn, "answer_quiz_question", "ok");
    return { saved: saved.saved, questionId, savedAt: saved.savedAt };
  })());

  server.registerTool("answer_quiz_questions", {
    title: "Answer whole quiz",
    description: "Save answers for many (or all) questions of the approved quiz attempt in one call: answers is a list of { questionId, answer } in the answerFormat from get_quiz_question. Same gate as answer_quiz_question (the approved entry session for this exact attempt; no extra approval). Every entry is validated first; the result lists each question as saved, rejected (with reason), unsupported_type, not_in_attempt, duplicate, failed or skipped, and a bad entry never blocks the others. Does NOT submit: call submit_quiz_attempt separately.",
    inputSchema: {
      quiz: quizRef,
      answers: z.array(z.object({ questionId: z.string().regex(/^\d{1,20}$/), answer: z.unknown().describe("See answerFormat in get_quiz_question") })).min(1).max(BULK_MAX_ENTRIES),
    }, annotations: { ...WRITE, idempotentHint: true },
  }, ({ quiz, answers }) => wrap("answer_quiz_questions", auth, async () => {
    const { quiz: q, conn } = await sessionFor(auth, "answer_quiz_questions", quiz);
    const read = await (isOneQuestionAtATime(q) ? getCurrentAttempt(auth.ctx, q.id).then(fromNativeBundle) : readCurrentAttempt(auth.ctx, q));
    const plan = planBulkAnswers(read.questions, answers.map((entry) => ({ questionId: entry.questionId, answer: entry.answer })));
    const started = Date.now();
    const results = await runBulkSave(plan,
      (questionId, answer, index) => saveAnswer(auth.ctx, q.id, questionId, answer, undefined, started + index),
      (error) => (error instanceof QuizServiceError ? { code: error.code, message: error.message } : null));
    const { counts, unansweredQuestionIds } = bulkSummary(results, read.questions);
    await auditQuiz(owner, conn, "answer_quiz_questions", counts.saved === results.length ? "ok" : `partial:${counts.saved ?? 0}/${results.length}`);
    return { quizId: q.id, attempt: read.attempt, counts, results, unansweredQuestionIds, submitted: false, next: "Review the results, then call submit_quiz_attempt only when the user is ready to submit." };
  })());

  server.registerTool("submit_quiz_attempt", {
    title: "Submit quiz",
    description: "Submit the approved quiz attempt, including graded attempts. Ends the quiz session.",
    inputSchema: { quiz: quizRef }, annotations: WRITE,
  }, ({ quiz }) => wrap("submit_quiz_attempt", auth, async () => {
    const { quiz: q, session, conn } = await sessionFor(auth, "submit_quiz_attempt", quiz);
    const result = await submitAttempt(auth.ctx, q.id, true, session.attempt, 0);
    await endSession(owner, session.id);
    await auditQuiz(owner, conn, "submit_quiz_attempt", "submitted");
    return { submitted: result.submitted, attempt: result.receipt.attempt, state: result.receipt.workflowState, score: result.receipt.score, keptScore: result.receipt.keptScore };
  })());

  // Outward Canvas writes stay hidden until their executors are supported (see executors.ts).
  if (EXECUTABLE_TOOLS.has("submit_assignment")) server.registerTool("submit_assignment", { title: "Submit assignment", description: "Stage an assignment submission for approval in Grove.", inputSchema: submitAssignmentArgs, annotations: WRITE }, (args) => wrap("submit_assignment", auth, async () => stageResult(await stageSubmitAssignment(auth, args)))());
  if (EXECUTABLE_TOOLS.has("reply_to_discussion")) server.registerTool("reply_to_discussion", { title: "Reply to discussion", description: "Stage a discussion reply for approval in Grove.", inputSchema: replyArgs, annotations: WRITE }, (args) => wrap("reply_to_discussion", auth, async () => stageResult(await stageDiscussionReply(auth, args)))());
  if (EXECUTABLE_TOOLS.has("send_message")) server.registerTool("send_message", { title: "Send message", description: "Stage a Canvas message for approval in Grove.", inputSchema: messageArgs, annotations: WRITE }, (args) => wrap("send_message", auth, async () => stageResult(await stageMessage(auth, args)))());
}
