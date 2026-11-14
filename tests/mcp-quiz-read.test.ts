import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../lib/mcp/content";
import { formatQuizQuestions, readModel } from "../lib/mcp/quiz-format";
import { planBulkAnswers, runBulkSave } from "../lib/mcp/quiz-bulk";
import { sessionAllows } from "../lib/mcp/action-policy";
import { sanitizeQuestion } from "../lib/quizzes/contracts";
import { renderCanvasHtml } from "../lib/views/canvas-html";

// Shapes below are de-identified copies of real Canvas quiz_submission_questions rows from a
// Computational Linear Algebra course (structure and attribute layout kept, wording replaced).
const ORIGIN = "https://school.instructure.com";
// Fill-in-blank ids come from the shared quiz sanitizer; tests that need them skip where it does not report them.
const BLANKS = ((sanitizeQuestion({ question_type: "fill_in_multiple_blanks_question", question_text: "[a]" }) as { blanks?: unknown[] }).blanks?.length ?? 0) === 1;
const eq = (latex: string, src = `${ORIGIN}/equation_images/${encodeURIComponent(encodeURIComponent(latex))}?scale=1`) =>
  `<img class="equation_image" title="${latex}" src="${src}" alt="LaTeX: ${latex}" data-equation-content="${latex}" data-ignore-a11y-check="" loading="lazy" x-canvaslms-safe-mathml="&lt;math xmlns=&quot;http://www.w3.org/1998/Math/MathML&quot;&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;/math&gt;">`;
const MATRIX = "A=\\begin{bmatrix} 2 &amp; 1 \\\\ 1 &amp; 2 \\end{bmatrix}";
const row = (over: Record<string, unknown>) => ({
  id: 101, quiz_id: 9, quiz_group_id: null, assessment_question_id: 7, position: 1, question_name: "Question", question_type: "multiple_answers_question",
  question_text: "<p>Pick all that apply.</p>", answers: [], matches: null, variables: null, formulas: null, answer_tolerance: null, formula_decimal_places: null, correct: null, flagged: false, ...over,
});

const fillInBlanks = row({ id: 201, question_type: "fill_in_multiple_blanks_question",
  question_text: `<p>For the matrix ${eq(MATRIX)}, find the eigenvalues.</p><p>λ1 = <input class="question_input" type="text" autocomplete="off" style="width: 120px;" name="question_201_0a1b2c3d4e5f60718293a4b5c6d7e8f9" value="{{question_201_0a1b2c3d4e5f60718293a4b5c6d7e8f9}}"></p><p>λ2 = <input class="question_input" type="text" autocomplete="off" style="width: 120px;" name="question_201_99887766554433221100aabbccddeeff" value="{{question_201_99887766554433221100aabbccddeeff}}"></p>`,
  answers: undefined });
const dropdowns = row({ id: 301, quiz_group_id: 55, question_type: "multiple_dropdowns_question",
  question_text: `<p>Let ${eq("B")} be invertible. <select class="question_input" name="question_301_aa"><option value="">[ Select ]</option><option value="11">always</option><option value="12">never</option></select> has a zero eigenvalue.</p>`,
  answers: [{ id: 11, text: "always", blank_id: "d1" }, { id: 12, text: "never", blank_id: "d1" }] });
const multipleAnswers = row({ id: 401, question_text: `<p>Which statements about ${eq("\\lambda")} are true?</p>`,
  answers: [{ id: 1, text: "", html: `${eq("x^2")}<span class="hidden-readable"><math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup></math></span> is nonnegative` }, { id: 2, text: "Plain choice", html: "" }] });

test("equations survive as LaTeX, including Grove-proxied relative srcs that used to be dropped", () => {
  // presentQuestions rewrites equation srcs to a relative Grove proxy; the old htmlToText dropped them entirely.
  const presented = renderCanvasHtml(`<p>Solve ${eq("x^2=4")}.</p>`, ORIGIN);
  assert.match(presented, /src="\/api\/canvas\/equation/);
  assert.equal(htmlToText(presented).text, "Solve \\(x^2=4\\) .");
  assert.equal(htmlToText(`<p>${eq(MATRIX)}</p>`).text, "\\(A=\\begin{bmatrix} 2 & 1 \\\\ 1 & 2 \\end{bmatrix}\\)");
  // Equation with only the image path (no data attributes): LaTeX decoded from the double-encoded path.
  assert.equal(htmlToText(`<img class="equation_image" src="/equation_images/${encodeURIComponent(encodeURIComponent("\\frac{1}{2}"))}">`).text, "\\(\\frac{1}{2}\\)");
});

test("screen-reader MathML copies are not duplicated; other markup becomes visible text", () => {
  const text = htmlToText((multipleAnswers.answers as Array<{ html: string }>)[0].html);
  assert.equal(text.text, "\\(x^2\\) is nonnegative");
  assert.equal(htmlToText('<p>x<sub>1</sub> + y<sup>10</sup></p>').text, "x_1 + y^{10}");
  assert.equal(htmlToText('<p><img src="/courses/1/files/2/preview" alt="Figure 1"> <img src="/x.png"></p>').text, "[image: Figure 1] [image]");
  assert.equal(htmlToText('<math><semantics><mi>y</mi><annotation encoding="application/x-tex">y^2</annotation></semantics></math>').text, "\\(y^2\\)");
  assert.equal(htmlToText("<p><video src='/v.mp4'></video></p>").text, "[video: open in Canvas]");
});

test("whole attempt: every real Linear Algebra question shape renders; unsavable ones are marked, not dropped", () => {
  const questions = formatQuizQuestions(readModel([multipleAnswers, fillInBlanks, dropdowns]));
  assert.equal(questions.length, 3);
  const [ma, fimb, dd] = questions;
  assert.equal(ma.answerable, true);
  assert.equal(ma.text.content, "Which statements about \\(\\lambda\\) are true?");
  assert.deepEqual(ma.options.map((o) => o.text), ["\\(x^2\\) is nonnegative", "Plain choice"]);
  // Canvas hides fill-in blank ids behind hashed input names in submission questions: show it, mark it.
  assert.equal(fimb.answerable, false);
  assert.match(fimb.note!, BLANKS ? /blank ids/ : /Answer this question in Canvas/);
  assert.match(fimb.text.content, /matrix \\\(A=\\begin\{bmatrix\} 2 & 1/);
  assert.match(fimb.text.content, /λ1 = \[blank 1\][\s\S]*λ2 = \[blank 2\]/);
  assert.equal(dd.answerable, false);
  assert.equal(dd.groupId, "55");
  assert.match(dd.text.content, /\[dropdown 1: always \| never\] has a zero eigenvalue/);
  assert.deepEqual(dd.options, []);
});

test("fill-in-blank questions with known blank ids expose them for answering", { skip: !BLANKS }, () => {
  const [q] = formatQuizQuestions(readModel([row({ id: 501, question_type: "fill_in_multiple_blanks_question", question_text: "<p>Rank is [r] and nullity is [n].</p>", answers: [{ id: 1, blank_id: "r" }, { id: 2, blank_id: "n" }] })]));
  assert.equal(q.answerable, true);
  assert.deepEqual(q.blanks, [{ marker: "blank 1", id: "r" }, { marker: "blank 2", id: "n" }]);
  assert.equal(q.text.content, "Rank is [blank 1] and nullity is [blank 2] .");
});

test("LaTeX brackets inside equation attributes are not mistaken for blank ids", { skip: !BLANKS }, () => {
  // Real shape: coordinate-vector LaTeX "[\vec{b}]_{B}" in the image attributes, hashed inputs as the real blanks.
  const latex = "[\\vec{b}]_{\\mathcal{B}} = \\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}";
  const raw = row({ id: 601, question_type: "fill_in_multiple_blanks_question", answers: undefined,
    question_text: `<p><span>Find ${eq(latex)}</span></p><p><span>c1 = <input class="question_input" type="text" name="question_601_0123456789abcdef0123456789abcdef" value=""></span></p><p><span>c2 = <input class="question_input" type="text" name="question_601_fedcba9876543210fedcba9876543210" value=""></span></p>` });
  assert.ok(((sanitizeQuestion(raw) as { blanks?: unknown[] }).blanks?.length ?? 0) > 0, "the shared sanitizer still finds the bogus id");
  const [q] = formatQuizQuestions(readModel([raw]));
  assert.equal(q.answerable, false);
  assert.equal(q.blanks, undefined);
  assert.match(q.text.content, /c1 = \[blank 1\][\s\S]*c2 = \[blank 2\]/);
  assert.match(q.text.content, /\\\(\[\\vec\{b\}\]_\{\\mathcal\{B\}\}/);
});

test("empty or unrepresentable content is reported, never silently blank", () => {
  const [q] = formatQuizQuestions([{ ...sanitizeQuestion(row({ question_text: "<p><span></span></p>" })), answerable: true, reason: null }]);
  assert.match(q.text.content, /could not show this content/);
});

// ------------------------------------------------------------------ bulk answering

const attempt = readModel([
  row({ id: 1, question_type: "multiple_choice_question", answers: [{ id: 10, text: "a" }, { id: 11, text: "b" }] }),
  row({ id: 2, question_type: "multiple_answers_question", answers: [{ id: 20, text: "a" }, { id: 21, text: "b" }] }),
  row({ id: 3, question_type: "numerical_question" }),
  row({ id: 4, question_type: "essay_question" }),
  row({ id: 5, question_type: "fill_in_multiple_blanks_question", question_text: "<p>[x] and [y]</p>", answers: [{ id: 1, blank_id: "x" }, { id: 2, blank_id: "y" }] }),
  row({ id: 6, question_type: "matching_question", answers: [{ id: 60, text: "left", match_id: 7 }], matches: [{ match_id: 7, text: "right" }] }),
  dropdowns,
]);

test("bulk answers: validated up front, per-question results, bad entries never reach Canvas", async () => {
  const plan = planBulkAnswers(attempt, [
    { questionId: "1", answer: 11 },
    { questionId: "2", answer: [20, 99] },          // option not in this question
    { questionId: "3", answer: "abc" },             // wrong type
    { questionId: "4", answer: "My essay" },
    { questionId: "5", answer: { x: "1", y: "2" } },
    { questionId: "6", answer: { 60: 7 } },          // matching: Grove cannot save it
    { questionId: "301", answer: { d1: 11 } },      // dropdowns: Grove cannot save it
    { questionId: "999", answer: 1 },                // not in the attempt
    { questionId: "1", answer: 10 },                 // duplicate
  ]);
  const saves: Array<[string, unknown]> = [];
  const results = await runBulkSave(plan, async (id, answer) => { saves.push([id, answer]); return { savedAt: "2026-11-13T00:00:00.000Z" }; }, () => null);
  assert.deepEqual(saves, [["1", 11], ["4", "My essay"], ...(BLANKS ? [["5", { x: "1", y: "2" }]] : [])]);
  assert.deepEqual(results.map((r) => `${r.questionId}:${r.status}${r.code ? `:${r.code}` : ""}`), [
    "1:saved", "2:rejected:INVALID_ANSWER_OPTION", "3:rejected:INVALID_ANSWER", "4:saved", BLANKS ? "5:saved" : "5:unsupported_type",
    "6:unsupported_type", "301:unsupported_type", "999:not_in_attempt", "1:duplicate",
  ]);
});

test("bulk answers: one failed save does not hide the others; a fatal one stops the batch explicitly", async () => {
  const entries = [{ questionId: "1", answer: 10 }, { questionId: "3", answer: 4 }, { questionId: "4", answer: "x" }, { questionId: "2", answer: [21] }];
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const known = (error: unknown) => (error instanceof Error && "code" in error ? { code: String((error as { code: string }).code), message: error.message } : null);
  const partial = await runBulkSave(planBulkAnswers(attempt, entries), async (id) => { if (id === "3") throw fail("QUIZ_SAVE_UNCONFIRMED"); return {}; }, known);
  assert.deepEqual(partial.map((r) => r.status), ["saved", "failed", "saved", "saved"]);
  const fatal = await runBulkSave(planBulkAnswers(attempt, entries), async (id) => { if (id === "3") throw fail("CANVAS_AUTH_EXPIRED"); return {}; }, known);
  assert.deepEqual(fatal.map((r) => r.status), ["saved", "failed", "skipped", "skipped"]);
  // Unknown errors are not swallowed.
  await assert.rejects(runBulkSave(planBulkAnswers(attempt, entries), async () => { throw new TypeError("boom"); }, known), TypeError);
});

test("bulk answers need the approved entry session, exactly like single answers", () => {
  const quizId = "q1";
  assert.equal(sessionAllows(null, quizId).ok, false);
  const session = { quiz_id: quizId, canvas_submission_id: "77", attempt: 2, expires_at: new Date(Date.now() + 60_000).toISOString(), ended_at: null };
  assert.equal(sessionAllows(session, quizId, { submissionId: "77", attempt: 2 }).ok, true);
  assert.equal(sessionAllows(session, "other", { submissionId: "77", attempt: 2 }).ok, false);
  assert.equal(sessionAllows(session, quizId, { submissionId: "78", attempt: 3 }).ok, false);
  assert.equal(sessionAllows({ ...session, ended_at: new Date().toISOString() }, quizId).ok, false);
});
