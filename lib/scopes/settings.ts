// Pure helpers for scope settings: request validation, stored-row decoding, MCP tool gating and
// orientation gates. No server-only imports, so the sync worker and tests can use them directly.

import {
  AGENT_ACCESS, DATA_SCOPES, DATA_SCOPE_INFO, DEFAULT_SCOPES, isAgentAccess, normalizeAutoCategories, normalizeDataScopes,
  type AgentAccess, type DataScope, type ScopeSettings,
} from "./catalog";
import type { AutoCategory } from "../mcp/categories";

export type ParsedScopes = { ok: true; value: Omit<ScopeSettings, "savedAt"> } | { ok: false; error: string };

/** Validates a PUT /api/settings/scopes body. Unknown scopes are rejected; `courses` is forced on. */
export function parseScopeSettingsBody(body: unknown): ParsedScopes {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send a JSON object with data and agent." };
  const { data, agent } = body as { data?: unknown; agent?: unknown };
  if (!Array.isArray(data) || data.length > DATA_SCOPES.length * 2) return { ok: false, error: "data must be a list of data areas." };
  const unknownScope = data.find((value) => typeof value !== "string" || !(DATA_SCOPES as readonly string[]).includes(value));
  if (unknownScope !== undefined) return { ok: false, error: `Unknown data area: ${String(unknownScope).slice(0, 40)}.` };
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return { ok: false, error: "agent must be an object with access and autoCategories." };
  const { access, autoCategories } = agent as { access?: unknown; autoCategories?: unknown };
  if (!isAgentAccess(access)) return { ok: false, error: `agent.access must be one of ${AGENT_ACCESS.join(", ")}.` };
  if (autoCategories !== undefined && !Array.isArray(autoCategories)) return { ok: false, error: "agent.autoCategories must be a list." };
  const categories = (autoCategories ?? []) as unknown[];
  const normalizedCategories = normalizeAutoCategories(categories);
  if (normalizedCategories.length !== new Set(categories).size) return { ok: false, error: "agent.autoCategories has an unknown category." };
  // Auto categories only make sense when agents may propose actions.
  return { ok: true, value: { data: normalizeDataScopes(data), agent: { access, autoCategories: access === "propose" ? normalizedCategories : [] } } };
}

/** Stored column -> enabled scopes. NULL (never saved) means the defaults: everything on. */
export function storedDataScopes(value: unknown): DataScope[] {
  return Array.isArray(value) ? normalizeDataScopes(value) : [...DEFAULT_SCOPES.data];
}

export function storedAgentDefaults(value: unknown): { access: AgentAccess; autoCategories: AutoCategory[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SCOPES.agent, autoCategories: [] };
  const { access, autoCategories } = value as { access?: unknown; autoCategories?: unknown };
  const safeAccess = isAgentAccess(access) ? access : DEFAULT_SCOPES.agent.access;
  return { access: safeAccess, autoCategories: safeAccess === "propose" && Array.isArray(autoCategories) ? normalizeAutoCategories(autoCategories) : [] };
}

type Stamp = Date | string | null | undefined;
export function scopeSettingsFromRow(row: { data_scopes?: unknown; agent_defaults?: unknown; scopes_saved_at?: Stamp } | null | undefined): ScopeSettings {
  const saved = row?.scopes_saved_at ? new Date(row.scopes_saved_at) : null;
  return { data: storedDataScopes(row?.data_scopes), agent: storedAgentDefaults(row?.agent_defaults), savedAt: saved && Number.isFinite(saved.getTime()) ? saved.toISOString() : null };
}

/** Whether a new connection should get canvas:write by default. */
export const agentDefaultAllowsActions = (settings: Pick<ScopeSettings, "agent">) => settings.agent.access === "propose";

// ------------------------------------------------------------------ MCP enforcement

/** The data area each MCP tool needs. null = always available (course list, status, Grove-local tools). */
export const TOOL_DATA_SCOPE: Record<string, DataScope | null> = {
  grove_status: null, list_courses: null, get_course: null, search: null,
  list_assignments: "assignments", get_assignment: "assignments", upcoming: "assignments", calendar: "assignments", list_planner_items: "assignments",
  grades: "grades",
  list_announcements: "announcements",
  list_pages: "content", get_page: "content", list_files: "content",
  list_quizzes: "quizzes", get_quiz: "quizzes", get_quiz_result: "quizzes", start_quiz_attempt: "quizzes", get_quiz_question: "quizzes",
  answer_quiz_question: "quizzes", answer_quiz_questions: "quizzes", submit_quiz_attempt: "quizzes",
  submit_assignment: "assignments", send_message: "inbox",
  submit_assignment_document: "assignments", upload_course_document: "content",
  // No scope is dedicated to discussions; they are course material, so "content" governs replies.
  reply_to_discussion: "content",
};

export const SCOPE_DISABLED = "SCOPE_DISABLED";

/** The disabled scope that blocks this tool, or null when the tool may run. */
export function blockedScopeForTool(tool: string, enabled: readonly DataScope[]): DataScope | null {
  const scope = TOOL_DATA_SCOPE[tool] ?? null;
  return scope && !enabled.includes(scope) ? scope : null;
}

export function scopeDisabledMessage(scope: DataScope): string {
  return `${DATA_SCOPE_INFO[scope].label} is turned off for Canvas Grove, so this tool cannot read it. The user can turn it on in Canvas Grove Settings > Data & permissions.`;
}

export class ScopeDisabledError extends Error {
  readonly code = SCOPE_DISABLED;
  constructor(readonly scope: DataScope) { super(scopeDisabledMessage(scope)); }
}

// ------------------------------------------------------------------ orientation gates

export type OnboardingGates = { extensionPaired: boolean; scopesSaved: boolean; canvasConnected: boolean; agentConnected: boolean };

/** Agent connection is skippable; the other three gates are required to finish orientation. */
export const onboardingGatesMet = (gates: OnboardingGates) => gates.extensionPaired && gates.scopesSaved && gates.canvasConnected;

export function gatesFromRow(row: { extension_paired?: unknown; scopes_saved?: unknown; canvas_connected?: unknown; agent_connected?: unknown } | null | undefined): OnboardingGates {
  return { extensionPaired: row?.extension_paired === true, scopesSaved: row?.scopes_saved === true, canvasConnected: row?.canvas_connected === true, agentConnected: row?.agent_connected === true };
}

// ------------------------------------------------------------------ grade redaction

const GRADE_KEYS = new Set(["currentScore", "currentGrade", "score", "grade", "keptScore"]);

/** With grades off, every grade/score field in an MCP result is nulled (other areas are gated per tool). */
export function redactForScopes<T>(value: T, enabled: readonly DataScope[]): T {
  if (enabled.includes("grades")) return value;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object" || node instanceof Date) return node;
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [key, GRADE_KEYS.has(key) && (child === null || typeof child !== "object") ? null : walk(child)]));
  };
  return walk(value) as T;
}
