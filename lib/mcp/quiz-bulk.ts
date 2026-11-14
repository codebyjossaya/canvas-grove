import { normalizeAnswer, QuizInputError, validateOptionAnswer } from "@/lib/quizzes/contracts";
import type { ReadQuestion } from "./quiz-format";

// Whole-quiz answering for answer_quiz_questions. Pure module: validation and the save loop take
// the attempt's questions and a save function, so they are unit-tested with mocked Canvas saves.
// It only SAVES answers inside the approved attempt; submitting stays submit_quiz_attempt.

export const BULK_MAX_ENTRIES = 200;

export type BulkEntry = { questionId: string; answer: unknown };
export type BulkResult = { questionId: string; status: "saved" | "rejected" | "unsupported_type" | "not_in_attempt" | "duplicate" | "failed" | "skipped"; code?: string; message?: string; savedAt?: string | null };
export type BulkPlan = { toSave: { questionId: string; answer: unknown }[]; results: Map<string, BulkResult>; order: string[] };

/** Validates every entry against the attempt before anything is saved. Bad entries never reach Canvas. */
export function planBulkAnswers(questions: ReadQuestion[], entries: BulkEntry[]): BulkPlan {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const results = new Map<string, BulkResult>();
  const order: string[] = [];
  const toSave: BulkPlan["toSave"] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    // Duplicates get a positional key so the first entry's result is never overwritten.
    const key = seen.has(entry.questionId) ? `${entry.questionId}#${index}` : entry.questionId;
    order.push(key);
    if (seen.has(entry.questionId)) { results.set(key, { questionId: entry.questionId, status: "duplicate", message: "This question appears more than once; only the first entry is used." }); return; }
    seen.add(entry.questionId);
    const question = byId.get(entry.questionId);
    if (!question) { results.set(key, { questionId: entry.questionId, status: "not_in_attempt", message: "That question is not part of this attempt." }); return; }
    if (!question.answerable) { results.set(key, { questionId: entry.questionId, status: "unsupported_type", message: question.reason ?? "Grove cannot save this question. Answer it in Canvas." }); return; }
    try {
      const answer = normalizeAnswer(question.type, entry.answer);
      validateOptionAnswer(question, answer);
      toSave.push({ questionId: entry.questionId, answer });
    } catch (error) {
      if (!(error instanceof QuizInputError)) throw error;
      results.set(key, { questionId: entry.questionId, status: error.code === "UNSUPPORTED_QUESTION_TYPE" ? "unsupported_type" : "rejected", code: error.code, message: error.message });
    }
  });
  return { toSave, results, order };
}

/** Errors after which no further save can succeed in this attempt (sign-in, attempt or session gone). */
export const FATAL_SAVE_CODES = new Set(["CANVAS_AUTH_EXPIRED", "NO_ACTIVE_ATTEMPT", "ATTEMPT_CHANGED", "QUIZ_SESSION_ENDED", "QUIZ_NOT_FOUND", "RATE_LIMITED", "QUIZ_PERMISSION_DENIED", "QUIZ_RESTRICTED"]);

/** Saves valid entries one at a time (Canvas tracks one validation token per attempt). One failure never hides the others. */
export async function runBulkSave(plan: BulkPlan, save: (questionId: string, answer: unknown, index: number) => Promise<{ savedAt?: string | null }>, errorCode: (error: unknown) => { code: string; message: string } | null): Promise<BulkResult[]> {
  let fatal: { code: string; message: string } | null = null;
  for (const [index, item] of plan.toSave.entries()) {
    if (fatal) { plan.results.set(item.questionId, { questionId: item.questionId, status: "skipped", code: fatal.code, message: `Not saved: an earlier save stopped the batch (${fatal.code}).` }); continue; }
    try {
      const saved = await save(item.questionId, item.answer, index);
      plan.results.set(item.questionId, { questionId: item.questionId, status: "saved", savedAt: saved.savedAt ?? null });
    } catch (error) {
      const known = errorCode(error);
      if (!known) throw error;
      plan.results.set(item.questionId, { questionId: item.questionId, status: "failed", code: known.code, message: known.message });
      if (FATAL_SAVE_CODES.has(known.code)) fatal = known;
    }
  }
  return plan.order.map((key) => plan.results.get(key)!);
}

export function bulkSummary(results: BulkResult[], questions: ReadQuestion[]) {
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  const answered = new Set(results.filter((r) => r.status === "saved").map((r) => r.questionId));
  const unanswered = questions.filter((q) => !answered.has(q.id) && q.answer == null).map((q) => q.id);
  return { counts, unansweredQuestionIds: unanswered };
}
