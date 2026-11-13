import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { envelopeEncryptBrowserState } from "../lib/bridge/providers/envelope";
import {
  CanvasSessionClient, QUIZ_WEB_MAX_BYTES, validateQuizWebPath,
  type CanvasTransport, type EncryptedStateStore, type QuizWebRequest, type QuizWebResult, type StoredCookie, type TransportRequest, type TransportResponse,
} from "../lib/canvas/session-client";
import { QuizInputError, restrictionReason } from "../lib/quizzes/contracts";
import {
  answerFields, oqaatBackup, oqaatBackupRequest, oqaatLoadAttempt, oqaatLoadPage, oqaatNavigate, oqaatPaths, oqaatRecordAnswerRequest, oqaatStart, oqaatStartRequest,
  oqaatSubmit, oqaatSubmitRequest, parseOqaatPage, type OqaatIds, type QuizWebClient,
} from "../lib/quizzes/oqaat";

process.env.BROWSER_STATE_KEK ??= randomBytes(32).toString("base64");
const ORIGIN = "https://school.instructure.com";
const OWNER = "00000000-0000-4000-8000-000000000001";
const IDS: OqaatIds = { courseId: "565820", quizId: "1632424" };
const USER = "1000001";
const SUBMISSION = "50299517";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/quiz-oqaat/${name}`, import.meta.url), "utf8");
const Q1 = fixture("take-q1.html"), Q2 = fixture("take-q2.html"), Q13 = fixture("take-q13.html");
type Recorded = { method?: string; url?: string; status?: number; sent?: Array<[string, string]>; redirectTo?: string; dialog?: string; message?: string };
const recorded = JSON.parse(fixture("recorded-requests.json")) as Recorded[];
const names = (fields: Array<[string, string]> | undefined) => (fields ?? []).map(([name]) => name);

/** Rewrite the current question in a fixture page (form half only; the sidebar is untouched). */
function variant(html: string, edit: (form: string) => string) {
  const split = html.indexOf('<div id="right-side-wrapper">');
  return edit(html.slice(0, split)) + html.slice(split);
}
function asQuestion(html: string, from: string, to: string) { return variant(html, (form) => form.replaceAll(from, to)); }
async function rejectsCode(promise: Promise<unknown> | (() => unknown), code: string) {
  await assert.rejects(async () => typeof promise === "function" ? promise() : promise, (error: unknown) => error instanceof QuizInputError && error.code === code);
}

// ---------------------------------------------------------------- parsing

test("parses the recorded first question page into the sanitized question model", () => {
  const page = parseOqaatPage(Q1, IDS);
  assert.equal(page.submissionId, SUBMISSION);
  assert.equal(page.userId, USER);
  assert.equal(page.attempt, 1);
  assert.equal(page.validationToken, "REDACTED");
  assert.equal(page.canvasType, "multiple_choice_question");
  assert.equal(page.question.id, "24736633");
  assert.equal(page.question.type, "multiple_choice");
  assert.equal(page.question.position, 1);
  assert.equal(page.question.pointsPossible, 1);
  assert.equal(page.question.answer, null);
  assert.equal(page.question.flagged, false);
  assert.deepEqual(page.question.options.map((option) => option.id), [4461, 9805, 8629, 471, 8285]);
  assert.match(page.question.questionTextHtml, /^\[Spray tan\]/);
  assert.equal(page.previousQuestionId, null);
  assert.equal(page.nextQuestionId, "24736649");
  assert.equal(page.list.length, 56);
  assert.ok(page.list.every((item) => item.linked));
  assert.equal(page.timing.timeLimitMinutes, 90);
  assert.equal(page.timing.endAt, "2026-11-11T15:20:13.000Z");
  assert.equal(typeof page.timing.timeLeftSeconds, "number");
  assert.equal(page.unsupported, null);
});

test("parses previous/next targets and sidebar answered state on later pages", () => {
  const q2 = parseOqaatPage(Q2, IDS);
  assert.equal(q2.question.id, "24736649");
  assert.equal(q2.question.position, 2);
  assert.equal(q2.previousQuestionId, "24736633");
  assert.equal(q2.nextQuestionId, "24736619");
  assert.equal(q2.list[0].answered, true);
  assert.equal(q2.list[1].current, true);
  const q13 = parseOqaatPage(Q13, IDS);
  assert.equal(q13.question.position, 13);
  assert.equal(q13.previousQuestionId, "24736650");
  assert.equal(q13.list.filter((item) => item.answered).length, 12);
});

test("the last page posts straight to submit and still yields the attempt id", () => {
  const last = variant(Q13, (form) => form
    .replace(/action="\/courses\/565820\/quizzes\/1632424\/submissions\/50299517\/record_answer\?[^"]*"/, `action="/courses/565820/quizzes/1632424/submissions?user_id=${USER}"`)
    .replace('class="one_question_at_a_time"', 'class="one_question_at_a_time last_page"')
    .replace(/<button type="submit"\s+class="Button submit_button\s+next-question"[\s\S]*?<\/button>/, ""));
  assert.doesNotMatch(last.slice(0, last.indexOf("right-side-wrapper")), /next-question/);
  const page = parseOqaatPage(last, IDS);
  assert.equal(page.submissionId, SUBMISSION);
  assert.equal(page.nextQuestionId, null);
  assert.equal(page.previousQuestionId, "24736650");
  const withEnv = last.replace(/<button type="submit"\s+class="Button submit_button\s+previous-question"[\s\S]*?<\/button>/, "")
    + `<script>ENV = {"QUIZ_SUBMISSION_EVENTS_URL":"https://school.instructure.com/api/v1/courses/565820/quizzes/1632424/submissions/${SUBMISSION}/events"}</script>`;
  assert.equal(parseOqaatPage(withEnv, IDS).submissionId, SUBMISSION);
  assert.throws(() => parseOqaatPage(last.replace(/<button type="submit"\s+class="Button submit_button\s+previous-question"[\s\S]*?<\/button>/, ""), IDS), /does not recognize/);
});

test("reads a stored answer and a flag that Canvas renders back", () => {
  const html = variant(Q2, (form) => form
    .replace('value="6142" id="question_24736649_answer_6142"', 'value="6142" checked id="question_24736649_answer_6142"')
    .replace('<a class="flag_question" role="checkbox" tabindex="0" aria-checked="false">', '<a class="flag_question marked" role="checkbox" tabindex="0" aria-checked="true">'));
  const page = parseOqaatPage(html, IDS);
  assert.equal(page.question.answer, 6142);
  assert.equal(page.question.flagged, true);
});

test("pages for another quiz, all-at-once forms or extra controls are rejected, not guessed", () => {
  assert.throws(() => parseOqaatPage(Q1, { courseId: "565820", quizId: "999" }), (error: unknown) => error instanceof QuizInputError && error.code === "QUIZ_PAGE_UNRECOGNIZED");
  assert.throws(() => parseOqaatPage(Q1.replace('class="one_question_at_a_time"', 'class=""'), IDS), /does not recognize/);
  assert.throws(() => parseOqaatPage(Q1.replace(/name="validation_token" value="[^"]*"/, 'name="validation_token" value=""'), IDS), /does not recognize/);
  assert.throws(() => parseOqaatPage(variant(Q1, (form) => form.replace("</fieldset>", '<input type="text" class="question_input" name="question_24736633_other" /></fieldset>')), IDS), /does not recognize/);
  assert.throws(() => parseOqaatPage("<html>login</html>", IDS), /does not recognize/);
});

test("unsupported question types and media fail clearly instead of silently", () => {
  const matching = parseOqaatPage(variant(Q1, (form) => form.replace('<span class="question_type">multiple_choice_question</span>', '<span class="question_type">matching_question</span>')), IDS);
  assert.equal(matching.unsupported?.code, "UNSUPPORTED_QUESTION_TYPE");
  assert.match(matching.unsupported?.message ?? "", /matching question/);
  const media = parseOqaatPage(variant(Q1, (form) => form.replaceAll("[Spray tan]", '<audio src="x.mp3"></audio>[Spray tan]')), IDS);
  assert.equal(media.unsupported?.code, "UNSUPPORTED_QUESTION_MEDIA");
});

test("parses multiple-answer, essay and short-answer controls", () => {
  const multi = parseOqaatPage(variant(Q1, (form) => form
    .replace("multiple_choice_question</span>", "multiple_answers_question</span>")
    .replace(/<input type="radio"\s+class="question_input" name="question_24736633" value="(\d+)"/g, '<input type="hidden" name="question_24736633_answer_$1" value="0"><input type="checkbox" class="question_input" name="question_24736633_answer_$1" value="1"')
    .replace('name="question_24736633_answer_471" value="1"', 'name="question_24736633_answer_471" value="1" checked')), IDS);
  assert.equal(multi.question.type, "multiple_answers");
  assert.deepEqual(multi.question.options.map((option) => option.id), [4461, 9805, 8629, 471, 8285]);
  assert.deepEqual(multi.question.answer, [471]);
  assert.deepEqual(answerFields(multi, [471, 8285]).filter(([, value]) => value === "1").map(([name]) => name), ["question_24736633_answer_471", "question_24736633_answer_8285"]);

  const answersStart = (form: string) => form.indexOf('<div class="answers">');
  const answersEnd = (form: string) => form.indexOf('<div class="after_answers">');
  const essay = parseOqaatPage(variant(Q1, (form) => form.slice(0, answersStart(form)).replace("multiple_choice_question</span>", "essay_question</span>")
    + '<div class="answers"><textarea class="question_input" name="question_24736633">&lt;p&gt;Draft&lt;/p&gt;</textarea></div>' + form.slice(answersEnd(form))), IDS);
  assert.equal(essay.question.type, "essay");
  assert.equal(essay.question.answer, "<p>Draft</p>");
  assert.deepEqual(answerFields(essay, "Final"), [["question_24736633", "Final"]]);

  const short = parseOqaatPage(variant(Q1, (form) => form.slice(0, answersStart(form)).replace("multiple_choice_question</span>", "short_answer_question</span>")
    + '<div class="answers"><input type="text" class="question_input" name="question_24736633" value="" /></div>' + form.slice(answersEnd(form))), IDS);
  assert.equal(short.question.type, "short_answer");
  assert.equal(short.question.answer, null);
});

// ---------------------------------------------------------------- request contracts vs. recordings

test("start, backup, record_answer and submit match the recorded player requests", () => {
  const page = parseOqaatPage(Q1, IDS);
  const recordedStart = recorded.find((item) => item.method === "POST" && /\/take\?user_id=/.test(item.url ?? ""))!;
  const start = oqaatStartRequest(IDS, USER);
  assert.equal(start.path, recordedStart.url);
  assert.deepEqual(names(start.form), names(recordedStart.sent).filter((name) => name !== "authenticity_token"));
  assert.equal(start.authenticityToken, true);

  // The recorded backup also serialized two disabled display-only textareas (question_text, text_after_answers); they carry no answer.
  const recordedBackup = recorded.find((item) => item.method === "PUT" && item.sent?.some(([name]) => name === "question_24736633"))!;
  const backup = oqaatBackupRequest(IDS, page, 471, false);
  assert.equal(backup.path, recordedBackup.url);
  assert.equal(backup.method, "PUT");
  assert.deepEqual(names(backup.form), names(recordedBackup.sent).filter((name) => !["authenticity_token", "question_text", "text_after_answers"].includes(name)));
  assert.deepEqual(backup.form!.find(([name]) => name === "question_24736633"), ["question_24736633", "471"]);

  const recordedNext = recorded.find((item) => item.method === "POST" && /record_answer/.test(item.url ?? "") && item.sent?.some(([name]) => name === "question_24736633"))!;
  const next = oqaatRecordAnswerRequest(IDS, { ...page, question: { ...page.question, answer: 471 } }, "24736649");
  assert.equal(next.path, `/courses/565820/quizzes/1632424/submissions/${SUBMISSION}/record_answer?next_question_path=%2Fcourses%2F565820%2Fquizzes%2F1632424%2Ftake%2Fquestions%2F24736649&user_id=${USER}`);
  assert.equal(recordedNext.redirectTo, "/courses/565820/quizzes/1632424/take/questions/24736649");
  assert.deepEqual(names(next.form), names(recordedNext.sent).filter((name) => name !== "authenticity_token"));

  const recordedSubmit = recorded.find((item) => item.method === "POST" && /\/submissions\?user_id=/.test(item.url ?? ""))!;
  const q13 = parseOqaatPage(Q13, IDS);
  const submit = oqaatSubmitRequest(IDS, { ...q13, question: { ...q13.question, answer: 3327 } });
  assert.equal(submit.path, recordedSubmit.url);
  assert.equal(recordedSubmit.redirectTo, "/courses/565820/quizzes/1632424");
  assert.deepEqual(names(submit.form), names(recordedSubmit.sent).filter((name) => name !== "authenticity_token"));
  assert.ok(recorded.some((item) => item.dialog === "confirm"), "Canvas asks for confirmation before submit; Quiz Mode requires confirmSubmit");
});

test("every builder path passes the allowlist; anything else is refused", () => {
  const page = parseOqaatPage(Q2, IDS);
  for (const request of [oqaatStartRequest(IDS, USER), oqaatBackupRequest(IDS, page, 6142, false), oqaatRecordAnswerRequest(IDS, page, "24736633"), oqaatSubmitRequest(IDS, page)]) {
    assert.equal(validateQuizWebPath(request.method, request.path), request.path);
  }
  assert.equal(validateQuizWebPath("GET", oqaatPaths.take(IDS)), oqaatPaths.take(IDS));
  assert.equal(validateQuizWebPath("GET", oqaatPaths.question(IDS, "24736649")), oqaatPaths.question(IDS, "24736649"));
  for (const [method, path] of [
    ["GET", "/courses/1/quizzes/2"], ["GET", "/login/canvas"], ["GET", "/api/v1/users/self"], ["PUT", "/courses/1/quizzes/2/take"],
    ["GET", "/courses/1/quizzes/2/take?user_id=3"], ["POST", "/courses/1/quizzes/2/take?user_id=3&x=1"],
    ["POST", "/courses/1/quizzes/2/submissions/3/record_answer?next_question_path=%2Fcourses%2F9%2Fquizzes%2F2%2Ftake&user_id=4"],
    ["POST", "/courses/1/quizzes/2/submissions/3/record_answer?next_question_path=https%3A%2F%2Fevil.test%2F&user_id=4"],
    ["POST", "/courses/1/quizzes/2/submissions/3/record_answer?next_question_path=%2Fcourses%2F1%2Fquizzes%2F2%2Ftake%2F..%2F..&user_id=4"],
    ["GET", "/courses/1/quizzes/2/submissions/backup?user_id=3"], ["DELETE", "/courses/1/quizzes/2/submissions?user_id=3"],
    ["GET", "/courses/1/quizzes/2/take/questions/3/../../x"], ["GET", "//evil.test/courses/1/quizzes/2/take"],
  ]) assert.throws(() => validateQuizWebPath(method, path), /not allowed/, `${method} ${path}`);
});

test("cant_go_back and quiz restrictions: one question at a time is allowed, the rest stay blocked", () => {
  assert.equal(restrictionReason({ one_question_at_a_time: true }), null);
  assert.match(restrictionReason({ one_question_at_a_time: true, cant_go_back: true }) ?? "", /prevents returning/);
  assert.match(restrictionReason({ one_question_at_a_time: true, require_lockdown_browser: true }) ?? "", /lockdown browser/);
  assert.match(restrictionReason({ one_question_at_a_time: true, access_code: "x" }) ?? "", /access code/);
  assert.match(restrictionReason({ one_question_at_a_time: true, ip_filter: "10.0.0.0/8" }) ?? "", /approved network/);
  assert.match(restrictionReason({ one_question_at_a_time: true }, "new_quiz") ?? "", /New Quizzes/);
});

// ---------------------------------------------------------------- session client transport

const cookie = (name: string, value: string): StoredCookie => ({ name, value, domain: "school.instructure.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" });
function memoryStore(cookies: StoredCookie[]): EncryptedStateStore {
  let current = envelopeEncryptBrowserState({ cookies, origins: [] }, OWNER);
  return { async load() { return { state: current, version: current.iv }; }, async compareAndSwap(next, expected) { if (current.iv !== expected) return false; current = next; return true; } };
}
function webClient(respond: (request: TransportRequest) => Partial<TransportResponse>, cookies = [cookie("canvas_session", "s"), cookie("_csrf_token", "csrf%2Btoken")]) {
  const calls: TransportRequest[] = [];
  const transport: CanvasTransport = async (request) => {
    calls.push(request);
    const response = respond(request);
    return { status: response.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...response.headers }, body: response.body ?? Buffer.alloc(0) };
  };
  return { client: new CanvasSessionClient({ ownerId: OWNER, canvasOrigin: ORIGIN, store: memoryStore(cookies), transport }), calls };
}

test("webRequest form-encodes fields, adds the cookie CSRF token itself and never follows redirects", async () => {
  const { client, calls } = webClient(() => ({ status: 302, headers: { location: `${ORIGIN}/courses/565820/quizzes/1632424/take` } }));
  const result = await client.webRequest(oqaatStartRequest(IDS, USER));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.href, `${ORIGIN}/courses/565820/quizzes/1632424/take?user_id=${USER}`);
  assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(calls[0].headers.origin, ORIGIN);
  assert.equal(calls[0].maxBytes, QUIZ_WEB_MAX_BYTES);
  assert.deepEqual([...new URLSearchParams(calls[0].body)], [["authenticity_token", "csrf+token"], ["_method", "post"]]);
  assert.equal(result.authRequired, false);
  assert.equal(result.location, "/courses/565820/quizzes/1632424/take");
});

test("webRequest puts the CSRF token after utf8 and sends XHR headers for backup", async () => {
  const { client, calls } = webClient(() => ({ headers: { "content-type": "application/json; charset=utf-8" }, body: Buffer.from('{"backup":true}') }));
  const page = parseOqaatPage(Q1, IDS);
  await client.webRequest(oqaatBackupRequest(IDS, page, 471, true));
  const sent = [...new URLSearchParams(calls[0].body)];
  assert.deepEqual(sent.map(([name]) => name).slice(0, 4), ["utf8", "authenticity_token", "attempt", "validation_token"]);
  assert.deepEqual(sent.find(([name]) => name === "question_24736633_marked"), ["question_24736633_marked", "1"]);
  assert.equal(calls[0].headers["x-requested-with"], "XMLHttpRequest");
  assert.match(calls[0].headers.accept, /application\/json/);
});

test("webRequest refuses caller tokens, GET bodies, unknown paths and a missing CSRF cookie", async () => {
  const { client, calls } = webClient(() => ({}));
  await assert.rejects(client.webRequest({ method: "POST", path: oqaatPaths.start(IDS, USER), form: [["authenticity_token", "x"]] }), /CSRF token is added by the client/);
  await assert.rejects(client.webRequest({ method: "GET", path: oqaatPaths.take(IDS), form: [["a", "b"]] }), /no form body/);
  await assert.rejects(client.webRequest({ method: "GET", path: "/courses/1/quizzes/2/edit" } as QuizWebRequest), /not allowed/);
  assert.equal(calls.length, 0);
  const noCsrf = webClient(() => ({}), [cookie("canvas_session", "s")]);
  await assert.rejects(noCsrf.client.webRequest(oqaatStartRequest(IDS, USER)), /CSRF token/);
  assert.equal(noCsrf.calls.length, 0);
});

test("webRequest auth handling: login redirect and unauthenticated 401 expire; permission 401 does not", async () => {
  const login = webClient(() => ({ status: 302, headers: { location: `${ORIGIN}/login/saml` } }));
  assert.deepEqual(await login.client.webRequest(oqaatPageRequestFor()), { status: 302, authRequired: true, contentType: "text/html; charset=utf-8", location: null, body: "" });
  const offOrigin = webClient(() => ({ status: 302, headers: { location: "https://idp.example.edu/sso" } }));
  assert.equal((await offOrigin.client.webRequest(oqaatPageRequestFor())).authRequired, true);
  const unauthenticated = webClient(() => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from('{"status":"unauthenticated"}') }));
  assert.equal((await unauthenticated.client.webRequest(oqaatPageRequestFor())).authRequired, true);
  const denied = webClient(() => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from('{"status":"unauthorized"}') }));
  const deniedResult = await denied.client.webRequest(oqaatPageRequestFor());
  assert.equal(deniedResult.authRequired, false);
  assert.equal(deniedResult.status, 401);
  const next = webClient(() => ({ status: 302, headers: { location: "/courses/565820/quizzes/1632424/take/questions/24736649" } }));
  const nextResult = await next.client.webRequest(oqaatPageRequestFor());
  assert.equal(nextResult.authRequired, false);
  assert.equal(nextResult.location, "/courses/565820/quizzes/1632424/take/questions/24736649");
});
function oqaatPageRequestFor(): QuizWebRequest { return { method: "GET", path: oqaatPaths.take(IDS), accept: "html" }; }

// ---------------------------------------------------------------- engine against a fake player

type Handler = (request: QuizWebRequest) => Partial<QuizWebResult>;
function fakePlayer(handler: Handler) {
  const calls: QuizWebRequest[] = [];
  const web: QuizWebClient = {
    async webRequest(request) {
      calls.push(request);
      const result = handler(request);
      return { status: 200, authRequired: false, contentType: "text/html; charset=utf-8", location: null, body: "", ...result };
    },
  };
  return { web, calls };
}
/** A three-question attempt built from the recorded pages. */
function threeQuestionPlayer(extra?: (request: QuizWebRequest) => Partial<QuizWebResult> | undefined) {
  const pages: Record<string, string> = {};
  const listOf = (html: string) => {
    const start = html.indexOf('<ul id="question_list"');
    const items = [...html.slice(start).matchAll(/<li id="list_question_(\d+)"[\s\S]*?<\/li>/g)].slice(0, 3).map((match) => match[0]);
    return html.slice(0, start) + `<ul id="question_list">${items.join("")}</ul></div></aside></div></body></html>`;
  };
  pages["24736633"] = listOf(Q1);
  pages["24736649"] = listOf(Q2);
  pages["24736619"] = listOf(asQuestion(Q1, "24736633", "24736619"));
  return fakePlayer((request) => {
    const custom = extra?.(request);
    if (custom) return custom;
    if (request.method === "GET" && request.path === oqaatPaths.take(IDS)) return { body: pages["24736633"] };
    const match = /\/take\/questions\/(\d+)$/.exec(request.path);
    if (request.method === "GET" && match && pages[match[1]]) return { body: pages[match[1]] };
    return { status: 404 };
  });
}

test("start posts /take and accepts only the player redirect", async () => {
  const ok = fakePlayer(() => ({ status: 302, location: "/courses/565820/quizzes/1632424/take" }));
  assert.deepEqual(await oqaatStart(ok.web, IDS, USER), { redirectedTo: "/courses/565820/quizzes/1632424/take" });
  assert.equal(ok.calls[0].path, `/courses/565820/quizzes/1632424/take?user_id=${USER}`);
  await rejectsCode(oqaatStart(fakePlayer(() => ({ status: 302, location: "/courses/565820/quizzes/1632424" })).web, IDS, USER), "QUIZ_START_REDIRECTED");
  await rejectsCode(oqaatStart(fakePlayer(() => ({ status: 302, authRequired: true })).web, IDS, USER), "CANVAS_AUTH_EXPIRED");
  await rejectsCode(oqaatStart(fakePlayer(() => ({ status: 200, body: "<html>access code</html>" })).web, IDS, USER), "CANVAS_QUIZ_UNEXPECTED");
  await rejectsCode(oqaatStart(fakePlayer(() => ({ status: 401, body: '{"status":"unauthorized"}' })).web, IDS, USER), "QUIZ_PERMISSION_DENIED");
});

test("loading an attempt reads every listed question in Canvas order with GETs only", async () => {
  const { web, calls } = threeQuestionPlayer();
  const { current, pages } = await oqaatLoadAttempt(web, IDS, { cantGoBack: false });
  assert.equal(current.question.id, "24736633");
  assert.deepEqual(pages.map((page) => [page.question.id, page.question.position]), [["24736633", 1], ["24736649", 2], ["24736619", 3]]);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.length, 3);
});

test("cant_go_back loads only the current question and never reads ahead", async () => {
  const { web, calls } = threeQuestionPlayer();
  const { pages } = await oqaatLoadAttempt(web, IDS, { cantGoBack: true });
  assert.equal(pages.length, 1);
  assert.equal(calls.length, 1);
});

test("a question redirect (time up, locked, cant_go_back) is reported, not followed", async () => {
  const { web } = fakePlayer(() => ({ status: 302, location: "/courses/565820/quizzes/1632424" }));
  await rejectsCode(oqaatLoadPage(web, IDS, "24736649"), "QUIZ_QUESTION_UNAVAILABLE");
  await rejectsCode(oqaatLoadPage(fakePlayer(() => ({ status: 302, authRequired: true })).web, IDS), "CANVAS_AUTH_EXPIRED");
});

test("backup validates the answer against Canvas's options and requires a confirmed save", async () => {
  const page = parseOqaatPage(Q1, IDS);
  const ok = fakePlayer(() => ({ contentType: "application/json", body: '{"backup":true,"end_at":"2026-11-11T15:20:13Z","time_left":4918}' }));
  const saved = await oqaatBackup(ok.web, IDS, page, { answer: 471 });
  assert.deepEqual(saved, { answer: 471, flagged: false, endAt: "2026-11-11T15:20:13.000Z", timeLeftSeconds: 4918 });
  assert.equal(ok.calls[0].method, "PUT");
  await rejectsCode(oqaatBackup(ok.web, IDS, page, { answer: 999 }), "INVALID_ANSWER_OPTION");
  await rejectsCode(oqaatBackup(ok.web, IDS, page, { answer: "471" }), "INVALID_ANSWER");
  assert.equal(ok.calls.length, 1, "invalid answers never reach Canvas");
  await rejectsCode(oqaatBackup(fakePlayer(() => ({ body: '{"backup":false}' })).web, IDS, page, { answer: 471 }), "QUIZ_SAVE_UNCONFIRMED");
  await rejectsCode(oqaatBackup(fakePlayer(() => ({ status: 302, authRequired: true })).web, IDS, page, { answer: 471 }), "CANVAS_AUTH_EXPIRED");
  const flagOnly = fakePlayer(() => ({ body: '{"backup":true}' }));
  const flagged = await oqaatBackup(flagOnly.web, IDS, { ...page, question: { ...page.question, answer: 471 } }, { flagged: true });
  assert.deepEqual([flagged.answer, flagged.flagged], [471, true]);
  assert.ok(flagOnly.calls[0].form!.some(([name, value]) => name === "question_24736633" && value === "471"), "a flag change resends the stored answer like the player does");
  const unsupported = parseOqaatPage(variant(Q1, (form) => form.replace("multiple_choice_question</span>", "matching_question</span>")), IDS);
  await rejectsCode(oqaatBackup(ok.web, IDS, unsupported, { answer: 1 }), "UNSUPPORTED_QUESTION_TYPE");
});

test("navigation posts record_answer and confirms the redirect before reading the target", async () => {
  const player = threeQuestionPlayer((request) => request.method === "POST" ? { status: 302, location: "/courses/565820/quizzes/1632424/take/questions/24736633" } : undefined);
  const q2 = await oqaatLoadPage(player.web, IDS, "24736649");
  const back = await oqaatNavigate(player.web, IDS, q2, "previous", { cantGoBack: false });
  assert.equal(back.question.id, "24736633");
  const post = player.calls.find((call) => call.method === "POST")!;
  assert.match(post.path, /record_answer\?next_question_path=%2Fcourses%2F565820%2Fquizzes%2F1632424%2Ftake%2Fquestions%2F24736633&user_id=1000001$/);

  const ended = threeQuestionPlayer((request) => request.method === "POST" ? { status: 302, location: "/courses/565820/quizzes/1632424" } : undefined);
  await rejectsCode(oqaatNavigate(ended.web, IDS, q2, "next", { cantGoBack: false }), "QUIZ_ATTEMPT_ENDED");
  const elsewhere = threeQuestionPlayer((request) => request.method === "POST" ? { status: 302, location: "/courses/565820/quizzes/1632424/take/questions/1" } : undefined);
  await rejectsCode(oqaatNavigate(elsewhere.web, IDS, q2, "next", { cantGoBack: false }), "QUIZ_NAVIGATION_UNCONFIRMED");
  await rejectsCode(oqaatNavigate(player.web, IDS, q2, "77", { cantGoBack: false }), "QUIZ_NO_SUCH_QUESTION");
});

test("cant_go_back refuses previous and jumps without contacting Canvas", async () => {
  const player = threeQuestionPlayer();
  const q2 = parseOqaatPage(Q2, IDS);
  await rejectsCode(oqaatNavigate(player.web, IDS, q2, "previous", { cantGoBack: true }), "QUIZ_CANT_GO_BACK");
  await rejectsCode(oqaatNavigate(player.web, IDS, q2, "24736633", { cantGoBack: true }), "QUIZ_CANT_GO_BACK");
  await rejectsCode(oqaatNavigate(player.web, IDS, q2, "24736656", { cantGoBack: true }), "QUIZ_CANT_GO_BACK");
  assert.equal(player.calls.length, 0);
});

test("submit requires the redirect back to the quiz page", async () => {
  const page = parseOqaatPage(Q13, IDS);
  const ok = fakePlayer(() => ({ status: 302, location: "/courses/565820/quizzes/1632424" }));
  assert.deepEqual(await oqaatSubmit(ok.web, IDS, page), { redirectedTo: "/courses/565820/quizzes/1632424" });
  assert.equal(ok.calls[0].path, `/courses/565820/quizzes/1632424/submissions?user_id=${USER}`);
  await rejectsCode(oqaatSubmit(fakePlayer(() => ({ status: 302, location: "/courses/565820/quizzes/1632424/take" })).web, IDS, page), "QUIZ_SUBMIT_UNCONFIRMED");
  await rejectsCode(oqaatSubmit(fakePlayer(() => ({ status: 302, authRequired: true })).web, IDS, page), "CANVAS_AUTH_EXPIRED");
  await rejectsCode(oqaatSubmit(fakePlayer(() => ({ status: 500 })).web, IDS, page), "CANVAS_QUIZ_FAILED");
});
