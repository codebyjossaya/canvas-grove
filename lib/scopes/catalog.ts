// Scope catalog shared by the orientation scopes step, Settings > Data & permissions, the
// settings API, the sync worker and the MCP server. Pure module: no server-only imports, safe in
// client components. All user-facing scope copy lives here so every surface reads the same words.

import type { AutoCategory } from "../mcp/categories";
import { AUTO_CATEGORIES } from "../mcp/categories";
import type { SyncKind } from "../sync/catalog";

export const DATA_SCOPES = ["courses", "assignments", "grades", "announcements", "inbox", "quizzes", "content"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export type DataScopeInfo = {
  label: string;
  description: string;
  /** Longer plain-language detail for an expandable row. */
  detail: string;
  required?: true;
  syncKinds: SyncKind[];
};

export const DATA_SCOPE_INFO: Record<DataScope, DataScopeInfo> = {
  courses: {
    label: "Courses",
    description: "Your course list, terms and favorites.",
    detail: "Grove needs your course list to organise everything else, so this one stays on.",
    required: true,
    syncKinds: ["courses", "favorites"],
  },
  assignments: {
    label: "Assignments and planner",
    description: "Assignments, due dates and planner items.",
    detail: "Used for your planner, deadlines and assignment details.",
    syncKinds: ["assignments", "planner"],
  },
  grades: {
    label: "Grades",
    description: "Course scores and grading-period totals.",
    detail: "Used for the grades view and grade calculations. Grove never changes a grade.",
    syncKinds: ["grades"],
  },
  announcements: {
    label: "Announcements",
    description: "Course announcements from your instructors.",
    detail: "Read from your Canvas activity stream for active courses.",
    syncKinds: ["announcements"],
  },
  inbox: {
    label: "Inbox",
    description: "Canvas conversations in your inbox.",
    detail: "Read so you can see and search messages in Grove. Sending a message always needs your approval.",
    syncKinds: ["inbox"],
  },
  quizzes: {
    label: "Quizzes",
    description: "Quiz list, availability windows and your attempts.",
    detail: "Used to show open quizzes and deadlines. Starting a quiz always needs your approval.",
    syncKinds: ["quizzes"],
  },
  content: {
    label: "Course content",
    description: "Pages, modules and files in your courses.",
    detail: "Used to browse and search course material in Grove and for connected agents.",
    syncKinds: ["course_content"],
  },
};

/** What Grove never reads, shown on consent surfaces. */
export const NEVER_ACCESSED = [
  "Your Canvas or school password",
  "Cookies for any site other than your Canvas host",
  "Your school sign-in (SSO) or MFA cookies",
] as const;

/** Settings copy: turning a scope off stops syncing but keeps data already stored. */
export const SCOPE_OFF_NOTE = "Turning an area off stops syncing it and hides it from Grove and connected agents. Data already synced stays stored until you delete your account data.";

export type AgentAccess = "read" | "propose";
export const AGENT_ACCESS = ["read", "propose"] as const;

export const AGENT_ACCESS_INFO: Record<AgentAccess, { label: string; description: string }> = {
  read: { label: "Read only", description: "Agents can read the areas you allow above. They cannot propose any Canvas action." },
  propose: { label: "Read and propose actions", description: "Agents can also propose actions such as submitting an assignment. Nothing is sent until you approve it in Grove." },
};

export type ScopeSettings = {
  data: DataScope[];
  agent: { access: AgentAccess; autoCategories: AutoCategory[] };
  savedAt: string | null;
};

export const REQUIRED_SCOPES: DataScope[] = DATA_SCOPES.filter((scope) => DATA_SCOPE_INFO[scope].required);

export const DEFAULT_SCOPES: ScopeSettings = {
  data: [...DATA_SCOPES],
  agent: { access: "propose", autoCategories: [] },
  savedAt: null,
};

export const isDataScope = (value: unknown): value is DataScope => typeof value === "string" && (DATA_SCOPES as readonly string[]).includes(value);
export const isAgentAccess = (value: unknown): value is AgentAccess => value === "read" || value === "propose";

/** Canonical order, de-duplicated, required scopes forced on. Unknown values are dropped. */
export function normalizeDataScopes(values: readonly unknown[]): DataScope[] {
  const set = new Set<DataScope>(REQUIRED_SCOPES);
  for (const value of values) if (isDataScope(value)) set.add(value);
  return DATA_SCOPES.filter((scope) => set.has(scope));
}

export function normalizeAutoCategories(values: readonly unknown[]): AutoCategory[] {
  const set = new Set(values.filter((value): value is AutoCategory => typeof value === "string" && (AUTO_CATEGORIES as readonly string[]).includes(value)));
  return AUTO_CATEGORIES.filter((category) => set.has(category));
}

/** The data scope that governs a sync kind. */
export function scopeForSyncKind(kind: SyncKind): DataScope {
  for (const scope of DATA_SCOPES) if (DATA_SCOPE_INFO[scope].syncKinds.includes(kind)) return scope;
  return "courses";
}

/** Sync kinds that must not run for the given enabled scopes. */
export function disabledSyncKinds(data: readonly DataScope[]): SyncKind[] {
  const enabled = new Set(data);
  return DATA_SCOPES.filter((scope) => !enabled.has(scope) && !DATA_SCOPE_INFO[scope].required).flatMap((scope) => DATA_SCOPE_INFO[scope].syncKinds);
}

export function isSyncKindAllowed(kind: SyncKind, data: readonly DataScope[]): boolean {
  return !disabledSyncKinds(data).includes(kind);
}
