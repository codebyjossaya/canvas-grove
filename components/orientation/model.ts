// Orientation v2: step list, view models and small pure helpers. No React, no network, so the
// fixture preview and tests can use it directly.
import type { UiError } from "@/components/ui/ui-errors";

export const ORIENTATION_STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "school", label: "Your school" },
  { id: "extension", label: "Install extension" },
  { id: "scopes", label: "Allow data" },
  { id: "signin", label: "Sign in to Canvas" },
  { id: "agent", label: "Connect your agent", optional: true },
  { id: "done", label: "Done" },
] as const;

export type StepId = (typeof ORIENTATION_STEPS)[number]["id"];
export const STEP_COUNT = ORIENTATION_STEPS.length;
export const stepIndex = (id: StepId) => ORIENTATION_STEPS.findIndex((step) => step.id === id);

export type School = { name: string; domain: string };

/** Mirrors `useExtension().status` (contract 2). */
export type ExtensionStatus = "checking" | "missing" | "outdated" | "unpaired" | "ready";
export type ExtensionView = { status: ExtensionStatus; version: string | null; deviceName: string | null };

/** Mirrors `useCanvasSignIn()` (contract 2), flattened for rendering. */
export type SignInPhase = "idle" | "starting" | "awaiting-tab-click" | "signing-in" | "verifying" | "connected" | "error";
export type SignInView = {
  phase: SignInPhase;
  accountName: string | null;
  canvasOrigin: string | null;
  error: UiError | null;
  existing: { connected: boolean; canvasOrigin: string; accountName?: string } | null;
  /** The user closed the sign-in tab before Canvas finished. */
  tabClosed?: boolean;
};

/** Mirrors `GET /api/onboarding` (contract 4). `gates` is optional so an older server still renders. */
export type OnboardingGates = { extensionPaired: boolean; scopesSaved: boolean; canvasConnected: boolean; agentConnected: boolean };

export type AgentConnection = { key: string; name: string; kind: "OAuth" | "Access token" };

/** "https://ufl.instructure.com/" or "ufl.instructure.com" -> "ufl.instructure.com". */
export function hostOf(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  try { return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).host; } catch { return trimmed.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""); }
}

export type GateState = { school: School | null; extensionReady: boolean; scopesSaved: boolean; canvasConnected: boolean; agentConnected: boolean };

/** The first step whose gate is not met (each gate needs every earlier one). Nothing past it is reachable. */
export function firstBlockedStep(state: GateState): number {
  if (!state.school) return stepIndex("school");
  if (!state.extensionReady) return stepIndex("extension");
  if (!state.scopesSaved) return stepIndex("scopes");
  if (!state.canvasConnected) return stepIndex("signin");
  return stepIndex("done");
}

/**
 * Where to resume, from real state. Brand-new users (nothing chosen) start at Welcome; everyone
 * else lands on the first unmet gate, or on the optional agent step if no agent is connected yet.
 */
export function resumeStep(state: GateState): number {
  if (!state.school && !state.canvasConnected) return stepIndex("welcome");
  const blocked = firstBlockedStep(state);
  if (blocked === stepIndex("done") && !state.agentConnected) return stepIndex("agent");
  return blocked;
}

/** Which required steps a 409 ORIENTATION_INCOMPLETE response points back to. */
export function missingSteps(gates: Partial<OnboardingGates> | null | undefined): StepId[] {
  if (!gates) return [];
  const missing: StepId[] = [];
  if (gates.extensionPaired === false) missing.push("extension");
  if (gates.scopesSaved === false) missing.push("scopes");
  if (gates.canvasConnected === false) missing.push("signin");
  return missing;
}

/** "Chrome on Windows". Used only to prefill the browser name; the user can edit it. */
export function guessBrowserName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Brave/.test(userAgent) ? "Brave" : /Chrome\//.test(userAgent) ? "Chrome" : "Browser";
  const os = /Windows/.test(userAgent) ? "Windows" : /Mac OS X/.test(userAgent) ? "Mac" : /CrOS/.test(userAgent) ? "ChromeOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** The extensions page to type into the address bar (web pages cannot link to it). */
export function extensionsPageFor(userAgent: string): string {
  return /Edg\//.test(userAgent) ? "edge://extensions" : "chrome://extensions";
}

type ConnectionsShape = { tokens: Array<{ id: string; name: string; lastUsedAt: string | null }>; grants: Array<{ id: string; clientName: string }> };

/** Connections that prove an agent actually connected: every OAuth grant, and tokens that were used. */
export function agentConnections(data: ConnectionsShape | null | undefined): AgentConnection[] {
  if (!data) return [];
  return [
    ...data.grants.map((grant): AgentConnection => ({ key: `g-${grant.id}`, name: grant.clientName, kind: "OAuth" })),
    ...data.tokens.filter((token) => token.lastUsedAt).map((token): AgentConnection => ({ key: `t-${token.id}`, name: token.name, kind: "Access token" })),
  ];
}

/** The first connection that was not there when the page loaded. */
export function newlyConnected(baseline: readonly string[] | null, current: AgentConnection[]): AgentConnection | null {
  if (!baseline) return null;
  return current.find((item) => !baseline.includes(item.key)) ?? null;
}
