import "server-only";
import type { CanvasRequest, Risk } from "./types";

type Definition = {
  risk: Risk;
  build(parameters: Record<string, unknown>): CanvasRequest;
};

const positiveId = (value: unknown, name: string) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a positive numeric Canvas id`);
  return text;
};

const text = (value: unknown, name: string, max = 10_000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} is required and must be at most ${max} characters`);
  return value.trim();
};

export const operations: Record<string, Definition> = {
  "courses.list": { risk: "read", build: () => ({ method: "GET", path: "/api/v1/courses?enrollment_state=active&per_page=100" }) },
  "assignments.list": { risk: "read", build: (p) => ({ method: "GET", path: `/api/v1/courses/${positiveId(p.courseId, "courseId")}/assignments?per_page=100` }) },
  "planner.upcoming": { risk: "read", build: () => ({ method: "GET", path: "/api/v1/users/self/upcoming_events?per_page=100" }) },
  "conversations.list": { risk: "read", build: () => ({ method: "GET", path: "/api/v1/conversations?per_page=100" }) },
  "conversations.reply": {
    risk: "consequential-write",
    build: (p) => ({ method: "POST", path: `/api/v1/conversations/${positiveId(p.conversationId, "conversationId")}/add_message`, body: { body: text(p.body, "body") } }),
  },
  "discussion.reply": {
    risk: "consequential-write",
    build: (p) => ({ method: "POST", path: `/api/v1/courses/${positiveId(p.courseId, "courseId")}/discussion_topics/${positiveId(p.topicId, "topicId")}/entries`, body: { message: text(p.message, "message") } }),
  },
  "assignment.submit": { risk: "disabled", build: () => { throw new Error("Assignment submission is disabled"); } },
  "quiz.complete": { risk: "disabled", build: () => { throw new Error("Quiz completion is disabled"); } },
};

export function buildOperation(name: string, parameters: Record<string, unknown>) {
  const definition = operations[name];
  if (!definition) throw new Error("Unsupported Canvas operation");
  if (definition.risk === "disabled") throw new Error("This operation is disabled");
  return { request: definition.build(parameters), risk: definition.risk };
}
