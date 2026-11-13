// Agent catalogue for the "Connect agent" UI. Pure data, no React.
// Facts here were checked against vendor docs; see docs/CONNECT_AGENT.md for sources and gaps.

export type AgentId = "claude" | "chatgpt" | "claude-code" | "cursor" | "vscode" | "codex" | "gemini" | "other";
export type Workflow = "app" | "terminal" | "ide";
export type AuthMode = "oauth" | "token";
/** "oauth" = only OAuth in our guide, "token" = only a personal access token, "either" = user picks. */
export type AuthSupport = "oauth" | "token" | "either";

export type Agent = {
  id: AgentId;
  vendor: string;
  name: string;
  blurb: string;
  workflows: Workflow[];
  auth: AuthSupport;
};

export const SERVER_NAME = "canvas-grove";

export const WORKFLOW_LABELS: Record<Workflow | "all", string> = { all: "All", app: "App", terminal: "Terminal", ide: "IDE" };

export const AGENTS: readonly Agent[] = [
  { id: "claude", vendor: "Anthropic", name: "Claude", blurb: "Add Grove as a custom connector in claude.ai or Claude Desktop. Sign in with OAuth.", workflows: ["app"], auth: "oauth" },
  { id: "chatgpt", vendor: "OpenAI", name: "ChatGPT", blurb: "Add Grove as a custom MCP connector in developer mode. Sign in with OAuth.", workflows: ["app"], auth: "oauth" },
  { id: "claude-code", vendor: "Anthropic", name: "Claude Code", blurb: "One command in your terminal. OAuth on first use, or a bearer token.", workflows: ["terminal"], auth: "either" },
  { id: "codex", vendor: "OpenAI", name: "Codex CLI", blurb: "Add a streamable HTTP server to config.toml. OAuth login or a token in an environment variable.", workflows: ["terminal"], auth: "either" },
  { id: "gemini", vendor: "Google", name: "Gemini CLI", blurb: "gemini mcp add with the HTTP transport. OAuth discovery or a bearer header.", workflows: ["terminal"], auth: "either" },
  { id: "cursor", vendor: "Anysphere", name: "Cursor", blurb: "One-click install link with OAuth, or .cursor/mcp.json with a token header.", workflows: ["ide"], auth: "either" },
  { id: "vscode", vendor: "GitHub Copilot agent mode", name: "VS Code", blurb: "Add a remote server in .vscode/mcp.json or with the code --add-mcp command. Uses a token.", workflows: ["ide"], auth: "token" },
  { id: "other", vendor: "Any client", name: "Other", blurb: "Any MCP client that supports remote Streamable HTTP servers: raw URL and generic JSON.", workflows: ["app", "terminal", "ide"], auth: "either" },
];

export function getAgent(id: string | null | undefined): Agent | undefined {
  return AGENTS.find(agent => agent.id === id);
}

export function agentsFor(filter: Workflow | "all"): readonly Agent[] {
  return filter === "all" ? AGENTS : AGENTS.filter(agent => agent.workflows.includes(filter));
}

export function defaultMode(agent: Agent): AuthMode {
  return agent.auth === "token" ? "token" : "oauth";
}

export function needsToken(agent: Agent, mode: AuthMode = defaultMode(agent)): boolean {
  return agent.auth === "token" || (agent.auth === "either" && mode === "token");
}
