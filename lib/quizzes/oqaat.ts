// One-question-at-a-time Classic quiz engine.
//
// Canvas refuses the REST questions API (HTTP 401 "unauthorized") for Classic
// quizzes that show one question at a time, because only its own quiz player
// may page through them. This module drives exactly the player requests that
// Canvas's own page makes (reverse-engineered from recordings of the player):
//
//   start     POST /courses/:c/quizzes/:q/take?user_id=:u       _method=post, authenticity_token -> 302 /take
//   page      GET  /courses/:c/quizzes/:q/take[/questions/:qid] -> HTML, form#submit_quiz_form.one_question_at_a_time
//   autosave  PUT  /courses/:c/quizzes/:q/submissions/backup?user_id=:u
//             utf8, authenticity_token, attempt, validation_token, question_<qid>..., last_question_id, question_<qid>_marked
//             -> 200 {"backup":true,"end_at","time_left"}
//   navigate  POST /courses/:c/quizzes/:q/submissions/:sid/record_answer?next_question_path=<take/questions/:qid>&user_id=:u
//             utf8, authenticity_token, attempt, validation_token, question_<qid>..., last_question_id -> 302 next_question_path
//   submit    POST /courses/:c/quizzes/:q/submissions?user_id=:u  (same fields as navigate) -> 302 /courses/:c/quizzes/:q
//
// `authenticity_token` is added by CanvasSessionClient from the `_csrf_token`
// cookie and never reaches this module; `attempt` and `validation_token` come
// from the hidden inputs of the page being answered. Pages are parsed into the
// same sanitized QuizQuestion model the REST flow produces. Anything this
// parser does not positively recognize is reported as unsupported rather than
// guessed at.
//
// Relative imports and no "server-only": dev scripts load this via tsx.
import type { QuizWebRequest, QuizWebResult } from "../canvas/session-client";
import { hasUnsupportedQuizMedia, normalizeAnswer, QuizInputError, quizFailure, safeQuizHtml, SUPPORTED_CLASSIC_QUESTION_TYPES, validateOptionAnswer, type QuizQuestion } from "./contracts";

export type QuizWebClient = { webRequest(request: QuizWebRequest): Promise<QuizWebResult> };
export type OqaatIds = { courseId: string; quizId: string };
export type OqaatListItem = { id: string; position: number; answered: boolean; flagged: boolean; current: boolean; linked: boolean };
export type OqaatTiming = { startedAt: string | null; endAt: string | null; timeLeftSeconds: number | null; timeLimitMinutes: number | null };
export type OqaatPage = {
  submissionId: string; userId: string; attempt: number;
  /** Secret per-attempt token from the page; never log it. */
  validationToken: string;
  canvasType: string;
  question: QuizQuestion;
  unsupported: { code: string; message: string } | null;
  list: OqaatListItem[];
  previousQuestionId: string | null; nextQuestionId: string | null;
  timing: OqaatTiming;
};

export const OQAAT_MAX_QUESTIONS = 500;
const UI_TYPES: Record<string, string> = { multiple_choice_question: "multiple_choice", true_false_question: "true_false", multiple_answers_question: "multiple_answers", short_answer_question: "short_answer", essay_question: "essay", numerical_question: "numerical", calculated_question: "calculated" };

// ---------------------------------------------------------------- request builders

function assertId(value: string, what = "quiz identifier") {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new QuizInputError("INVALID_CANVAS_ID", `Canvas returned an invalid ${what}.`);
  return value;
}

export const oqaatPaths = {
  quiz: (ids: OqaatIds) => `/courses/${assertId(ids.courseId)}/quizzes/${assertId(ids.quizId)}`,
  take: (ids: OqaatIds) => `${oqaatPaths.quiz(ids)}/take`,
  start: (ids: OqaatIds, userId: string) => `${oqaatPaths.take(ids)}?user_id=${assertId(userId, "user identifier")}`,
  question: (ids: OqaatIds, questionId: string) => `${oqaatPaths.take(ids)}/questions/${assertId(questionId, "question identifier")}`,
  recordAnswer: (ids: OqaatIds, submissionId: string, nextPath: string, userId: string) =>
    `${oqaatPaths.quiz(ids)}/submissions/${assertId(submissionId)}/record_answer?next_question_path=${encodeURIComponent(nextPath)}&user_id=${assertId(userId, "user identifier")}`,
  backup: (ids: OqaatIds, userId: string) => `${oqaatPaths.quiz(ids)}/submissions/backup?user_id=${assertId(userId, "user identifier")}`,
  submit: (ids: OqaatIds, userId: string) => `${oqaatPaths.quiz(ids)}/submissions?user_id=${assertId(userId, "user identifier")}`,
};

export function oqaatStartRequest(ids: OqaatIds, userId: string): QuizWebRequest {
  return { method: "POST", path: oqaatPaths.start(ids, userId), form: [["_method", "post"]], authenticityToken: true, accept: "html" };
}
export function oqaatPageRequest(ids: OqaatIds, questionId?: string): QuizWebRequest {
  return { method: "GET", path: questionId ? oqaatPaths.question(ids, questionId) : oqaatPaths.take(ids), accept: "html" };
}

function baseFields(page: OqaatPage): Array<[string, string]> {
  if (!page.validationToken) throw new QuizInputError("QUIZ_SESSION_UNAVAILABLE", "Canvas did not return the secure token needed to save this attempt. Continue in Canvas.", 409);
  return [["utf8", "✓"], ["attempt", String(page.attempt)], ["validation_token", page.validationToken]];
}

/** Form fields Canvas's player sends for this question's answer (none when unanswered). */
export function answerFields(page: OqaatPage, answer: unknown): Array<[string, string]> {
  const id = page.question.id;
  if (answer === null || answer === undefined) return [];
  switch (page.question.type) {
    case "multiple_choice": case "true_false": return [[`question_${id}`, String(answer)]];
    case "multiple_answers": {
      const chosen = new Set((Array.isArray(answer) ? answer : []).map(Number));
      return page.question.options.map((option): [string, string] => [`question_${id}_answer_${option.id}`, chosen.has(option.id) ? "1" : "0"]);
    }
    case "short_answer": case "essay": case "numerical": case "calculated": return [[`question_${id}`, String(answer)]];
    default: throw new QuizInputError("UNSUPPORTED_QUESTION_TYPE", "This question type must be completed directly in Canvas.");
  }
}

export function oqaatBackupRequest(ids: OqaatIds, page: OqaatPage, answer: unknown, flagged: boolean): QuizWebRequest {
  return {
    method: "PUT", path: oqaatPaths.backup(ids, page.userId), authenticityToken: true, accept: "json",
    form: [...baseFields(page), ...answerFields(page, answer), ["last_question_id", page.question.id], [`question_${page.question.id}_marked`, flagged ? "1" : ""]],
  };
}
export function oqaatRecordAnswerRequest(ids: OqaatIds, page: OqaatPage, targetQuestionId: string): QuizWebRequest {
  return {
    method: "POST", path: oqaatPaths.recordAnswer(ids, page.submissionId, oqaatPaths.question(ids, targetQuestionId), page.userId), authenticityToken: true, accept: "html",
    form: [...baseFields(page), ...answerFields(page, page.question.answer), ["last_question_id", page.question.id]],
  };
}
export function oqaatSubmitRequest(ids: OqaatIds, page: OqaatPage): QuizWebRequest {
  return {
    method: "POST", path: oqaatPaths.submit(ids, page.userId), authenticityToken: true, accept: "html",
    form: [...baseFields(page), ...answerFields(page, page.question.answer), ["last_question_id", page.question.id]],
  };
}

// ---------------------------------------------------------------- HTML parsing

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

type Tag = { name: string; index: number; end: number; attrs: Record<string, string> };
function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<[a-zA-Z][\w-]*/, "").replace(/\/?>$/, "");
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let match = re.exec(body); match; match = re.exec(body)) {
    const name = match[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}
function tags(html: string, names: string): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(`<(${names})\\b[^>]*>`, "gi");
  for (let match = re.exec(html); match; match = re.exec(html)) out.push({ name: match[1].toLowerCase(), index: match.index, end: match.index + match[0].length, attrs: parseAttributes(match[0]) });
  return out;
}
const classes = (attrs: Record<string, string>) => new Set((attrs.class ?? "").split(/\s+/).filter(Boolean));
const hasClass = (attrs: Record<string, string>, name: string) => classes(attrs).has(name);

/** Inner HTML of the element whose opening tag ends at `openEnd`, matching nested tags of the same name. */
function innerOf(html: string, name: string, openEnd: number): { inner: string; close: number } | null {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = openEnd;
  let depth = 1;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    if (match[0].endsWith("/>")) continue;
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { inner: html.slice(openEnd, match.index), close: match.index + match[0].length };
  }
  return null;
}
function elementById(html: string, id: string, name = "div") {
  const tag = tags(html, name).find((item) => item.attrs.id === id);
  return tag ? innerOf(html, name, tag.end)?.inner ?? null : null;
}
function spanText(html: string, className: string): string | null {
  const tag = tags(html, "span").find((item) => hasClass(item.attrs, className));
  if (!tag) return null;
  const inner = innerOf(html, "span", tag.end)?.inner;
  return inner == null ? null : decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
}

function unrecognized(detail: string): never {
  throw new QuizInputError("QUIZ_PAGE_UNRECOGNIZED", `Canvas returned a quiz page Quiz Mode does not recognize (${detail}). Your attempt is preserved; continue it in Canvas.`, 502);
}

function questionIdFromAction(action: string | undefined, ids: OqaatIds): string | null {
  if (!action) return null;
  try {
    const url = new URL(action, "https://canvas.invalid");
    const next = url.searchParams.get("next_question_path") ?? "";
    const match = /^\/courses\/(\d+)\/quizzes\/(\d+)\/take\/questions\/(\d+)$/.exec(next);
    return match && match[1] === ids.courseId && match[2] === ids.quizId ? match[3] : null;
  } catch { return null; }
}

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function numberOrNull(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseOqaatPage(html: string, ids: OqaatIds): OqaatPage {
  if (typeof html !== "string" || html.length > 4 * 1024 * 1024) unrecognized("page too large");
  const formTag = tags(html, "form").find((tag) => tag.attrs.id === "submit_quiz_form");
  if (!formTag) unrecognized("no quiz form");
  const formClose = html.indexOf("</form>", formTag.end);
  if (formClose < 0) unrecognized("unterminated quiz form");
  const form = html.slice(formTag.end, formClose);
  if (!hasClass(formTag.attrs, "one_question_at_a_time")) unrecognized("not a one-question-at-a-time form");

  // Every page but the last posts to record_answer; the last page's form posts straight to the submit route.
  const action = /^\/courses\/(\d+)\/quizzes\/(\d+)\/submissions(?:\/(\d+)\/record_answer)?\?(.*)$/.exec(formTag.attrs.action ?? "");
  if (!action || action[1] !== ids.courseId || action[2] !== ids.quizId) unrecognized("form for a different quiz");
  const userId = new URLSearchParams(action[4]).get("user_id") ?? "";
  if (!/^\d{1,20}$/.test(userId)) unrecognized("no user id");
  const buttons = tags(form, "button");
  const submissionIds = new Set<string>(action[3] ? [action[3]] : []);
  for (const button of buttons) {
    const match = /^\/courses\/(\d+)\/quizzes\/(\d+)\/submissions\/(\d+)\/record_answer\?/.exec(button.attrs["data-action"] ?? "");
    if (match && match[1] === ids.courseId && match[2] === ids.quizId) submissionIds.add(match[3]);
  }
  // Canvas also embeds the attempt's event-log URL (ENV.QUIZ_SUBMISSION_EVENTS_URL) on every player page.
  for (const match of html.matchAll(/\/api\/v1\/courses\/(\d+)\/quizzes\/(\d+)\/submissions\/(\d+)\/events/g)) {
    if (match[1] === ids.courseId && match[2] === ids.quizId) submissionIds.add(match[3]);
  }
  if (submissionIds.size !== 1) unrecognized(submissionIds.size ? "conflicting submission ids" : "no submission id");
  const submissionId = [...submissionIds][0];

  const inputs = tags(form, "input");
  const hidden = (name: string) => inputs.find((tag) => tag.attrs.name === name)?.attrs.value ?? null;
  const attempt = Number(hidden("attempt"));
  const validationToken = hidden("validation_token") ?? "";
  if (!Number.isInteger(attempt) || attempt < 1) unrecognized("no attempt number");
  if (!validationToken) unrecognized("no validation token");

  const quizUrls = elementById(form, "quiz_urls") ?? "";
  const timing: OqaatTiming = {
    startedAt: isoOrNull(spanText(quizUrls, "started_at")), endAt: isoOrNull(spanText(quizUrls, "end_at")),
    timeLeftSeconds: numberOrNull(spanText(quizUrls, "time_left")), timeLimitMinutes: numberOrNull(spanText(quizUrls, "time_limit")),
  };

  const blocks = tags(form, "div").filter((tag) => hasClass(tag.attrs, "display_question") && /^question_\d+$/.test(tag.attrs.id ?? ""));
  if (blocks.length !== 1) unrecognized(`${blocks.length} questions on one page`);
  const block = blocks[0];
  const questionId = block.attrs.id!.slice("question_".length);
  const blockHtml = innerOf(form, "div", block.end)?.inner;
  if (blockHtml == null) unrecognized("unterminated question");

  const submitTag = tags(form, "button").find((tag) => tag.attrs.id === "submit_quiz_button");
  if (submitTag?.attrs["data-action"] !== oqaatPaths.submit(ids, userId)) unrecognized("unexpected submit target");
  const previousQuestionId = questionIdFromAction(buttons.find((tag) => hasClass(tag.attrs, "previous-question"))?.attrs["data-action"], ids);
  const nextQuestionId = questionIdFromAction(buttons.find((tag) => hasClass(tag.attrs, "next-question"))?.attrs["data-action"], ids);

  // Sidebar question list (after the form). Absent links mean Canvas will not let the student jump there.
  const list: OqaatListItem[] = [];
  const listTag = tags(html, "ul").find((tag) => tag.attrs.id === "question_list");
  const listHtml = listTag ? innerOf(html, "ul", listTag.end)?.inner ?? "" : "";
  for (const item of tags(listHtml, "li")) {
    const match = /^list_question_(\d+)$/.exec(item.attrs.id ?? "");
    if (!match) continue;
    const inner = innerOf(listHtml, "li", item.end)?.inner ?? "";
    const link = tags(inner, "a").find((tag) => tag.attrs.href === oqaatPaths.question(ids, match[1]));
    list.push({ id: match[1], position: list.length + 1, answered: hasClass(item.attrs, "answered"), flagged: hasClass(item.attrs, "marked"), current: hasClass(item.attrs, "current_question"), linked: Boolean(link) });
  }
  if (list.length > OQAAT_MAX_QUESTIONS) throw new QuizInputError("QUIZ_TOO_LARGE", `This quiz has more than ${OQAAT_MAX_QUESTIONS} questions and must be completed directly in Canvas.`, 409);
  const listed = list.find((item) => item.id === questionId);

  const parsed = parseQuestionBlock(blockHtml, questionId);
  const nameText = spanText(blockHtml, "question_name") ?? "";
  const position = listed?.position ?? (Number(/(\d+)\s*$/.exec(nameText)?.[1]) || 0);
  return {
    submissionId, userId, attempt, validationToken, canvasType: parsed.canvasType,
    question: { ...parsed.question, position, flagged: parsed.question.flagged || Boolean(listed?.flagged) },
    unsupported: parsed.unsupported, list, previousQuestionId, nextQuestionId, timing,
  };
}

function parseQuestionBlock(block: string, id: string): { canvasType: string; question: QuizQuestion; unsupported: OqaatPage["unsupported"] } {
  const canvasType = spanText(block, "question_type") ?? "unknown";
  const type = UI_TYPES[canvasType] ?? canvasType;
  const points = numberOrNull(spanText(block, "question_points"));
  const rawText = elementById(block, `question_${id}_question_text`);
  const flag = tags(block, "a").find((tag) => hasClass(tag.attrs, "flag_question"));
  const flagged = Boolean(flag && (flag.attrs["aria-checked"] === "true" || hasClass(flag.attrs, "marked")));
  const base: QuizQuestion = { id, position: 0, type, questionTextHtml: safeQuizHtml((rawText ?? "").trim()), pointsPossible: points, flagged, answer: null, options: [] };
  const unsupported = (code: string, message: string) => ({ canvasType, question: base, unsupported: { code, message } });
  if (!SUPPORTED_CLASSIC_QUESTION_TYPES.has(canvasType)) return unsupported("UNSUPPORTED_QUESTION_TYPE", `This attempt contains ${canvasType.replaceAll("_", " ")} questions that native Quiz Mode cannot safely save. Your active attempt has been preserved; continue it directly in Canvas.`);
  if (rawText == null) unrecognized("no question text");
  const media = "This attempt contains audio, video, or embedded content that native Quiz Mode cannot play. Your active attempt has been preserved; continue it directly in Canvas.";
  if (hasUnsupportedQuizMedia(rawText)) return unsupported("UNSUPPORTED_QUESTION_MEDIA", media);

  // Every answer control Canvas rendered for this question must be one this parser understands.
  const controls = tags(block, "input|textarea|select").filter((tag) => (tag.attrs.name ?? "").startsWith(`question_${id}`));
  const label = (answerId: number) => elementById(block, `question_${id}_answer_${answerId}_label`);
  const optionFrom = (answerId: number) => {
    const html = label(answerId);
    if (html == null) unrecognized("answer without a label");
    return { id: answerId, textHtml: safeQuizHtml(html.trim()) };
  };
  let options: QuizQuestion["options"] = [];
  let answer: unknown = null;
  if (canvasType === "multiple_choice_question" || canvasType === "true_false_question") {
    const radios = controls.filter((tag) => tag.name === "input" && tag.attrs.type === "radio" && tag.attrs.name === `question_${id}` && /^\d{1,20}$/.test(tag.attrs.value ?? ""));
    if (!radios.length || radios.length !== controls.length) unrecognized("unexpected choice controls");
    options = radios.map((tag) => optionFrom(Number(tag.attrs.value)));
    const checked = radios.find((tag) => "checked" in tag.attrs && tag.attrs.checked !== "false");
    answer = checked ? Number(checked.attrs.value) : null;
  } else if (canvasType === "multiple_answers_question") {
    const boxes = controls.filter((tag) => tag.name === "input" && tag.attrs.type === "checkbox" && new RegExp(`^question_${id}_answer_\\d{1,20}$`).test(tag.attrs.name ?? ""));
    const companions = controls.filter((tag) => tag.name === "input" && tag.attrs.type === "hidden" && boxes.some((box) => box.attrs.name === tag.attrs.name));
    if (!boxes.length || boxes.length + companions.length !== controls.length) unrecognized("unexpected multiple-answer controls");
    options = boxes.map((tag) => optionFrom(Number(tag.attrs.name!.slice(`question_${id}_answer_`.length))));
    const chosen = boxes.filter((tag) => "checked" in tag.attrs && tag.attrs.checked !== "false").map((tag) => Number(tag.attrs.name!.slice(`question_${id}_answer_`.length)));
    answer = chosen.length ? chosen : null;
  } else if (canvasType === "essay_question") {
    const areas = controls.filter((tag) => tag.name === "textarea" && tag.attrs.name === `question_${id}`);
    if (areas.length !== 1 || controls.length !== 1) unrecognized("unexpected essay controls");
    const content = innerOf(block, "textarea", tags(block, "textarea").find((tag) => tag.attrs.name === `question_${id}`)!.end)?.inner ?? "";
    const value = decodeEntities(content);
    answer = value.trim() ? value : null;
  } else {
    const fields = controls.filter((tag) => tag.name === "input" && ["text", "number", ""].includes(tag.attrs.type ?? "") && tag.attrs.name === `question_${id}`);
    if (fields.length !== 1 || controls.length !== 1) unrecognized("unexpected text answer controls");
    const value = fields[0].attrs.value ?? "";
    answer = value.trim() ? value : null;
  }
  if (options.some((option) => hasUnsupportedQuizMedia(option.textHtml))) return unsupported("UNSUPPORTED_QUESTION_MEDIA", media);
  return { canvasType, question: { ...base, options, answer }, unsupported: null };
}

// ---------------------------------------------------------------- engine

async function send(web: QuizWebClient, request: QuizWebRequest): Promise<QuizWebResult> {
  const result = await web.webRequest(request);
  if (result.authRequired) { const failure = quizFailure(401, true); throw new QuizInputError(failure.code, failure.error, failure.status); }
  return result;
}
function fail(result: QuizWebResult): never {
  if (result.status >= 200 && result.status < 400) throw new QuizInputError("CANVAS_QUIZ_UNEXPECTED", "Canvas answered the quiz request in an unexpected way. Nothing was submitted automatically; check the attempt in Canvas.", 502);
  const failure = quizFailure(result.status, false);
  throw new QuizInputError(failure.code, failure.error, failure.status);
}
const isRedirect = (result: QuizWebResult) => result.status >= 300 && result.status < 400;
const locationPath = (result: QuizWebResult) => (result.location ?? "").split("?")[0];

/** Start (or reopen) the attempt the way the "Take the Quiz" button does. Callers must already know no attempt is active. */
export async function oqaatStart(web: QuizWebClient, ids: OqaatIds, userId: string) {
  const result = await send(web, oqaatStartRequest(ids, userId));
  const target = locationPath(result);
  if (isRedirect(result) && (target === oqaatPaths.take(ids) || target.startsWith(`${oqaatPaths.take(ids)}/questions/`))) return { redirectedTo: target };
  if (isRedirect(result)) throw new QuizInputError("QUIZ_START_REDIRECTED", "Canvas did not open its quiz player for this attempt. Check the quiz in Canvas before retrying.", 409);
  fail(result);
}

/** Read the current question (no id) or a specific one. GET only; Canvas does not record answers on reads. */
export async function oqaatLoadPage(web: QuizWebClient, ids: OqaatIds, questionId?: string): Promise<OqaatPage> {
  const result = await send(web, oqaatPageRequest(ids, questionId));
  if (result.status === 200 && /text\/html/i.test(result.contentType)) {
    const page = parseOqaatPage(result.body, ids);
    if (questionId && page.question.id !== questionId) unrecognized("Canvas showed a different question");
    return page;
  }
  if (isRedirect(result)) throw new QuizInputError("QUIZ_QUESTION_UNAVAILABLE", "Canvas did not open this question. The attempt may have ended, or this quiz may not allow returning to it.", 409);
  fail(result);
}

async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; output[index] = await work(items[index]); }
  }));
  return output;
}

/**
 * Load the attempt: the current page, then (when the quiz allows moving
 * freely) every other listed question, in Canvas order. With cant_go_back only
 * the current question is ever read, so no question is opened out of order.
 */
export async function oqaatLoadAttempt(web: QuizWebClient, ids: OqaatIds, options: { cantGoBack: boolean; concurrency?: number }) {
  const current = await oqaatLoadPage(web, ids);
  if (options.cantGoBack) return { current, pages: [current] };
  if (!current.list.length || !current.list.some((item) => item.id === current.question.id)) unrecognized("no question list");
  const others = current.list.filter((item) => item.id !== current.question.id);
  if (others.some((item) => !item.linked)) unrecognized("questions that cannot be opened directly");
  const loaded = await mapLimited(others, options.concurrency ?? 3, (item) => oqaatLoadPage(web, ids, item.id));
  for (const page of loaded) {
    if (page.submissionId !== current.submissionId || page.attempt !== current.attempt) throw new QuizInputError("QUIZ_ATTEMPT_CHANGED", "Canvas changed attempts while Quiz Mode was loading it. Reload before continuing.", 409);
  }
  const byId = new Map([current, ...loaded].map((page) => [page.question.id, page]));
  return { current, pages: current.list.map((item) => byId.get(item.id)!) };
}

/** Autosave one question's answer and/or flag exactly like the player's backup XHR. */
export async function oqaatBackup(web: QuizWebClient, ids: OqaatIds, page: OqaatPage, change: { answer?: unknown; flagged?: boolean }) {
  if (page.unsupported) throw new QuizInputError(page.unsupported.code, page.unsupported.message, 409);
  let answer = page.question.answer;
  if (change.answer !== undefined) { answer = normalizeAnswer(page.question.type, change.answer); validateOptionAnswer(page.question, answer); }
  const flagged = change.flagged ?? page.question.flagged;
  const result = await send(web, oqaatBackupRequest(ids, page, answer, flagged));
  if (result.status !== 200) fail(result);
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(result.body.replace(/^while\(1\);/, "")) as Record<string, unknown>; } catch { data = {}; }
  if (data.backup !== true) throw new QuizInputError("QUIZ_SAVE_UNCONFIRMED", "Canvas did not confirm this answer was saved. Retry the save before moving on.", 502);
  const timeLeft = Number(data.time_left);
  return { answer, flagged, endAt: typeof data.end_at === "string" ? isoOrNull(data.end_at) : null, timeLeftSeconds: data.time_left == null || !Number.isFinite(timeLeft) ? null : timeLeft };
}

/** Move to another question via record_answer (Next/Previous), then read it. Honors cant_go_back. */
export async function oqaatNavigate(web: QuizWebClient, ids: OqaatIds, page: OqaatPage, target: "next" | "previous" | string, options: { cantGoBack: boolean }) {
  if (page.unsupported) throw new QuizInputError(page.unsupported.code, page.unsupported.message, 409);
  let targetId: string | null;
  if (target === "next") targetId = page.nextQuestionId;
  else if (target === "previous") targetId = page.previousQuestionId;
  else targetId = page.list.some((item) => item.id === target) ? target : null;
  if (!targetId) throw new QuizInputError("QUIZ_NO_SUCH_QUESTION", "There is no question in that direction in this attempt.", 409);
  // cant_go_back: Canvas's player only ever offers "Next"; never go back or skip ahead.
  if (options.cantGoBack && (target === "previous" || targetId !== page.nextQuestionId)) {
    throw new QuizInputError("QUIZ_CANT_GO_BACK", "This quiz does not allow returning to earlier questions or skipping ahead.", 409);
  }
  const result = await send(web, oqaatRecordAnswerRequest(ids, page, targetId));
  if (!isRedirect(result)) fail(result);
  const landed = locationPath(result);
  if (landed === oqaatPaths.quiz(ids)) throw new QuizInputError("QUIZ_ATTEMPT_ENDED", "Canvas ended this attempt (it may have been submitted or timed out). Check the quiz in Canvas.", 409);
  if (landed !== oqaatPaths.question(ids, targetId)) throw new QuizInputError("QUIZ_NAVIGATION_UNCONFIRMED", "Canvas did not move to the requested question. Reload before continuing.", 502);
  return oqaatLoadPage(web, ids, targetId);
}

/** Final submission, as #submit_quiz_button does. The caller confirms completion through the API afterwards. */
export async function oqaatSubmit(web: QuizWebClient, ids: OqaatIds, page: OqaatPage) {
  if (page.unsupported) throw new QuizInputError(page.unsupported.code, page.unsupported.message, 409);
  const result = await send(web, oqaatSubmitRequest(ids, page));
  if (isRedirect(result) && locationPath(result) === oqaatPaths.quiz(ids)) return { redirectedTo: locationPath(result) };
  if (isRedirect(result)) throw new QuizInputError("QUIZ_SUBMIT_UNCONFIRMED", "Canvas did not confirm the submission. Check the attempt in Canvas before retrying.", 502);
  fail(result);
}
