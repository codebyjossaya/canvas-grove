import { isRecord, questionHasUnsupportedMedia, safeQuizHtml, sanitizeQuestion, type QuizQuestion as ContractQuestion } from "@/lib/quizzes/contracts";
import { htmlToText, untrusted, type Untrusted } from "./content";

// Fill-in-blank ids are optional here so this module works whether or not the shared sanitizer reports them.
type QuizQuestion = ContractQuestion & { blanks?: { id: string }[]; inlineBlankCount?: number };

// Quiz questions -> MCP output. Pure module (unit-tested with real, de-identified Canvas shapes).
//
// Reading never drops a question: every question of the attempt is returned with its text, math as
// LaTeX, blanks and dropdowns as numbered inline markers, and `answerable: false` plus a reason when
// Grove cannot save that kind of answer (the assistant then tells the user to answer it in Canvas).

/** Question types Grove can save through Canvas's quiz-submission API. */
export const ANSWERABLE_TYPES = new Set(["multiple_choice", "true_false", "multiple_answers", "fill_in_multiple_blanks", "short_answer", "essay", "numerical", "calculated"]);

export type ReadQuestion = QuizQuestion & { answerable: boolean; reason: string | null; groupId?: string; matches?: { id: number; textHtml: string }[] };

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = (type: string) => type.replace(/_question$/, "").replaceAll("_", " ");

/** Why Grove cannot save an answer to this question, or null when it can. */
export function unanswerableReason(question: QuizQuestion, raw: Record<string, unknown>): string | null {
  if (!ANSWERABLE_TYPES.has(question.type)) return `Grove cannot save ${label(question.type)} answers. Answer this question in Canvas.`;
  if (question.type === "fill_in_multiple_blanks" && !question.blanks?.length) return "Canvas did not expose this question's blank ids, so Grove cannot save it. Answer this question in Canvas.";
  if (questionHasUnsupportedMedia(raw)) return "This question contains audio, video or embedded content. Answer it in Canvas.";
  return null;
}

/**
 * Blank ids the sanitizer found are only trusted when they are real: a [name] in the VISIBLE text,
 * a Canvas answer blank_id or a saved-answer key. Real Linear Algebra questions carry LaTeX such as
 * "[\vec{b}]_{B}" inside equation-image attributes, which the bracket scan mistook for blanks while
 * the real blanks were hashed inputs. Untrusted ids are dropped (the question becomes read-only).
 */
function trustedBlanks(question: QuizQuestion, raw: Record<string, unknown>, source: Record<string, unknown>): QuizQuestion {
  if (question.type !== "fill_in_multiple_blanks" || !question.blanks?.length) return question;
  const visible = String(source.question_text ?? "").replace(/<[^>]*>/g, " ");
  const valid = new Set([...visible.matchAll(/\[([^\]\r\n]{1,128})\]/g)].map((m) => m[1].trim()));
  for (const answer of (Array.isArray(source.answers) ? source.answers : []).filter(isRecord)) if (typeof answer.blank_id === "string") valid.add(answer.blank_id.trim());
  if (isRecord(raw.answer)) for (const key of Object.keys(raw.answer)) valid.add(key);
  return question.blanks.every((blank) => valid.has(blank.id)) ? question : { ...question, blanks: [], inlineBlankCount: 0 };
}

/** Canvas quiz_submission_questions rows -> sanitized questions, each marked answerable or not. */
export function readModel(rawQuestions: Record<string, unknown>[]): ReadQuestion[] {
  return rawQuestions.filter(isRecord).map((raw) => {
    const source = isRecord(raw.quiz_question) ? raw.quiz_question : raw;
    const sanitized = trustedBlanks(sanitizeQuestion(raw) as QuizQuestion, raw, source);
    // Canvas sends answers with both `html` and `text`; an empty html ("") must fall back to text,
    // otherwise plain-text choices render as empty options.
    const plain = new Map((Array.isArray(source.answers) ? source.answers : []).filter(isRecord).map((a) => [Number(a.id), typeof a.text === "string" ? a.text : ""]));
    // Without blank ids the sanitizer turns each input into "_____"; keep the inputs so they render as [blank N].
    const questionTextHtml = sanitized.type === "fill_in_multiple_blanks" && !sanitized.blanks?.length ? safeQuizHtml(source.question_text) : sanitized.questionTextHtml;
    const question = { ...sanitized, questionTextHtml, options: sanitized.options.map((o) => (o.textHtml.trim() ? o : { ...o, textHtml: escapeHtml(plain.get(o.id) ?? "") })) };
    const reason = unanswerableReason(question, raw);
    const matches = question.type === "matching_question" && Array.isArray(source.matches)
      ? source.matches.filter(isRecord).filter((m) => Number.isInteger(Number(m.match_id))).map((m) => ({ id: Number(m.match_id), textHtml: String(m.text ?? "") }))
      : [];
    // Question groups/pools: the attempt already holds the drawn questions; keep their group id.
    const group = raw.quiz_group_id ?? source.quiz_group_id;
    return { ...question, answerable: reason === null, reason, ...(group != null && /^\d{1,20}$/.test(String(group)) ? { groupId: String(group) } : {}), ...(matches.length ? { matches } : {}) };
  });
}

export type QuestionOut = {
  questionId: string; position: number; type: string; points: number | null; groupId?: string; text: Untrusted;
  options: { id: number; text: string; matchId?: number }[];
  blanks?: { marker: string; id: string }[];
  matches?: { id: number; text: string }[];
  savedAnswer: unknown; answerable: boolean; note?: string;
};

const EMPTY_TEXT = "[Grove could not show this content as text. Open the question in Canvas.]";
const textOf = (html: string, max: number) => {
  const text = htmlToText(html, max).text;
  return text || (html.trim() ? EMPTY_TEXT : "");
};

/** MCP shape for get_quiz_question. `answerable` defaults to true for questions from Grove's native bundle. */
export function formatQuizQuestions(questions: Array<QuizQuestion & Partial<Pick<ReadQuestion, "answerable" | "reason" | "groupId" | "matches">>>): QuestionOut[] {
  return questions.map((item) => {
    const out: QuestionOut = {
      questionId: item.id, position: item.position, type: item.type, points: item.pointsPossible,
      text: untrusted(textOf(item.questionTextHtml, 8_000)),
      // Dropdown choices are shown inline in the text as [dropdown N: a | b].
      options: item.type === "multiple_dropdowns_question" ? [] : item.options.map((o) => ({ id: o.id, text: textOf(o.textHtml, 1_000), ...(o.matchId != null ? { matchId: o.matchId } : {}) })),
      savedAnswer: item.answer ?? null,
      answerable: item.answerable ?? true,
    };
    if (item.groupId) out.groupId = item.groupId;
    if (item.blanks?.length) out.blanks = item.blanks.map((blank, index) => ({ marker: `blank ${index + 1}`, id: blank.id }));
    if (item.matches?.length) out.matches = item.matches.map((m) => ({ id: m.id, text: textOf(m.textHtml, 1_000) }));
    if (item.reason) out.note = item.reason;
    return out;
  });
}
