// Fixture data for the preview route. Not imported by production screens.
import type { ActionsPayload, ApprovalAction } from "./model";
import type { AutoTarget } from "./auto-model";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function fixtureAwaiting(now: number): ApprovalAction[] {
  const base = { status: "awaiting_approval" as const, decidedBy: null, decidedAt: null };
  return [
    { ...base, id: "a1", tool: "submit_assignment", category: "submit_assignment", title: "Submit Essay 2 draft", summary: "submit your text entry to Essay 2 draft in Principles of Marketing", preview: { lines: [{ label: "Course", value: "MAR 3023 Principles of Marketing" }, { label: "Assignment", value: "Essay 2 draft" }, { label: "Type", value: "Online text entry" }, { label: "Text", value: "Brand positioning rests on three ideas: segmentation, targeting and differentiation. In this essay I compare..." }], warning: "Submitting counts as your attempt 1 of 2. You cannot edit it afterwards." }, client: { name: "Claude Code", connectionId: "t1", kind: "token" }, createdAt: iso(now - 4 * MIN), expiresAt: iso(now + 26 * MIN) },
    { ...base, id: "a2", tool: "start_quiz_attempt", category: "quiz_entry", title: "Start graded quiz: Chapter 4 check", summary: "Let Claude take this graded quiz: it can read the questions, answer them and submit this attempt.", preview: { lines: [{ label: "Course", value: "STA 2023 Introduction to Statistics" }, { label: "Quiz", value: "Chapter 4 check" }, { label: "Type", value: "Graded quiz" }, { label: "Points", value: "20" }, { label: "Attempts allowed", value: "1" }, { label: "Time limit", value: "20 minutes" }], warning: "This is a graded Canvas assessment. Starting uses an attempt and may start a timer; its answers and submission may affect your course grade. This approval covers one attempt only." }, client: { name: "Claude", connectionId: "g1", kind: "grant" }, createdAt: iso(now - 2 * MIN), expiresAt: iso(now + 3 * MIN + 20_000) },
    { ...base, id: "a3", tool: "reply_to_discussion", category: "outward_messages", title: "Reply in Week 7 discussion", summary: "post a reply to Maria Lopez in the Week 7 discussion", preview: { lines: [{ label: "Course", value: "DIG 3878 Designing Interactive Experiences" }, { label: "Topic", value: "Week 7: Prototyping" }, { label: "Reply", value: "Good point about low-fidelity first. I would add that testing with two users already exposes most navigation issues." }], warning: "Everyone in the course can see this reply under your name." }, client: { name: "Cursor", connectionId: "t2", kind: "token" }, createdAt: iso(now - 12 * MIN), expiresAt: iso(now + 18 * MIN) },
  ];
}

export function fixtureHistory(now: number): ApprovalAction[] {
  const mk = (partial: Partial<ApprovalAction> & Pick<ApprovalAction, "id" | "title" | "status" | "decidedBy">): ApprovalAction => ({ tool: "submit_assignment", category: "submit_assignment", summary: partial.title, preview: { lines: [{ label: "Course", value: "MAR 3023 Principles of Marketing" }] }, client: { name: "Claude Code", connectionId: "t1", kind: "token" }, createdAt: iso(now - 3_600_000), expiresAt: iso(now - 3_600_000 + 30 * MIN), decidedAt: iso(now - 3_000_000), ...partial });
  return [
    mk({ id: "h1", title: "Submit Homework 5", status: "done", decidedBy: "you", result: { ok: true, message: "Submitted. Canvas confirmed attempt 1." } }),
    mk({ id: "h2", title: "Start quiz: Chapter 3", category: "quiz_entry", tool: "start_quiz_attempt", status: "done", decidedBy: "auto", client: { name: "Claude", connectionId: "g1", kind: "grant" }, result: { ok: true, message: "Attempt started and submitted by the assistant." } }),
    mk({ id: "h3", title: "Reply in Week 6 discussion", category: "outward_messages", tool: "reply_to_discussion", status: "failed", decidedBy: "you", result: { ok: false, message: "Canvas says the discussion is locked." } }),
    mk({ id: "h4", title: "Send message to Prof. Chen", category: "outward_messages", tool: "send_message", status: "rejected", decidedBy: "you" }),
    mk({ id: "h5", title: "Submit Essay 1", status: "expired", decidedBy: "system", decidedAt: null }),
  ];
}

export function fixturePayload(now: number, view: "awaiting" | "history"): ActionsPayload {
  const awaiting = fixtureAwaiting(now);
  return view === "awaiting" ? { awaitingCount: awaiting.length, actions: awaiting } : { awaitingCount: awaiting.length, actions: fixtureHistory(now) };
}

const off = { enabled: false, categories: [], expiresAt: null, usedLastHour: 0, usedToday: 0 };
export type AutoScenario = "off" | "on" | "expiring" | "capped" | "readonly";
/** Targets matching the Connect agent fixture ids (t1, t2 tokens; g1 grant). */
export function fixtureAutoTargets(now: number, scenario: AutoScenario): AutoTarget[] {
  const on = { enabled: true, categories: ["submit_assignment", "quiz_entry"], expiresAt: iso(now + 5 * 3_600_000 + 12 * MIN), usedLastHour: 3, usedToday: 11 };
  const grant = (auto: AutoTarget["auto"], canPropose = true): AutoTarget => ({ kind: "grant", id: "g1", name: "Claude", canPropose, auto });
  const t1 = (auto: AutoTarget["auto"], canPropose = true): AutoTarget => ({ kind: "token", id: "t1", name: "Claude Code on laptop", canPropose, auto });
  const t2: AutoTarget = { kind: "token", id: "t2", name: "Cursor (work)", canPropose: false, auto: off };
  switch (scenario) {
    case "on": return [grant(on), t1(off), t2];
    case "expiring": return [grant({ ...on, expiresAt: iso(now + 6 * MIN + 30_000) }), t1(off), t2];
    case "capped": return [grant({ ...on, usedLastHour: 30, usedToday: 64 }), t1(off), t2];
    case "readonly": return [grant(off, false), t1(off, false), t2];
    default: return [grant(off), t1(off), t2];
  }
}
