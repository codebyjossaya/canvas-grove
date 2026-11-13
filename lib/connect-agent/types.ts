import type { AgentId, AuthMode } from "./catalog";

export type GuideStep = { text: string; copy?: string };
export type GuideSnippet = { label: string; language: "bash" | "json" | "toml" | "text"; code: string; /** true when `code` contains the real token */ hasToken?: boolean };
export type Guide = {
  agentId: AgentId;
  mode: AuthMode;
  steps: GuideStep[];
  snippets: GuideSnippet[];
  /** One-click install link. Only present where the vendor documents the format; never contains a token. */
  deeplink?: { label: string; href: string };
  /** Shown when a one-click link is intentionally absent. */
  noDeeplinkReason?: string;
  notes: string[];
};
export type GuideOptions = { serverUrl: string; token?: string | null; mode?: AuthMode };

/** Pre-computed values every builder needs. `token` is the real token or the placeholder. */
export type Ctx = {
  serverUrl: string;
  /** shell-quoted server URL */
  url: string;
  token: string;
  hasToken: boolean;
  /** shell-quoted `Authorization: Bearer <token>` */
  header: string;
  /** step telling the user to create a token first; empty once a token exists */
  tokenStep: GuideStep[];
};
export type Builder = (mode: AuthMode, ctx: Ctx) => Omit<Guide, "agentId" | "mode">;
