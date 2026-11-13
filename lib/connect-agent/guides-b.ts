import { SERVER_NAME } from "./catalog";
import { jsonBlock, shellQuote, tomlString } from "./encode";
import type { Builder } from "./types";

export const vscode: Builder = (_mode, { serverUrl, token, hasToken, tokenStep }) => {
  const entry = { type: "http", url: serverUrl, headers: { Authorization: `Bearer ${token}` } };
  const file = jsonBlock({ servers: { [SERVER_NAME]: entry } });
  const addMcp = `code --add-mcp ${shellQuote(JSON.stringify({ name: SERVER_NAME, ...entry }))}`;
  return {
    steps: [
      ...tokenStep,
      { text: "Create .vscode/mcp.json in your workspace (the root key is servers, not mcpServers) and paste this.", copy: file },
      { text: "Or add it to your user profile from a terminal.", copy: addMcp },
      { text: "Open the Command Palette, run MCP: List Servers and start canvas-grove." },
    ],
    snippets: [{ label: ".vscode/mcp.json", language: "json", code: file, hasToken }, { label: "code --add-mcp", language: "bash", code: addMcp, hasToken }],
    noDeeplinkReason: "No one-click link: the vscode:mcp/install format is not in VS Code's official docs, and links must not carry a token.",
    notes: [
      "Do not commit .vscode/mcp.json with a real token in it; use the user-profile command or keep the file out of git.",
      "Unverified: VS Code's docs we could read do not confirm OAuth sign-in for remote servers, so this guide uses a token.",
    ],
  };
};

export const codex: Builder = (mode, { url, token, hasToken, tokenStep, serverUrl }) => {
  if (mode === "oauth") {
    const toml = `[mcp_servers.${SERVER_NAME}]\nurl = ${tomlString(serverUrl)}`;
    return {
      steps: [
        { text: "Add this to ~/.codex/config.toml.", copy: toml },
        { text: "Sign in with OAuth.", copy: `codex mcp login ${SERVER_NAME}` },
        { text: "Or add the server from the command line, then run the login command above.", copy: `codex mcp add ${SERVER_NAME} --url ${url}` },
      ],
      snippets: [{ label: "~/.codex/config.toml", language: "toml", code: toml }],
      noDeeplinkReason: "Codex uses config or commands instead of a link.",
      notes: [
        "On a machine without a browser add --no-browser to codex mcp login and paste the redirect URL back.",
        "Unverified: the docs show codex mcp add --url only together with --oauth-client-id. The config.toml route is the documented one.",
      ],
    };
  }
  const toml = `[mcp_servers.${SERVER_NAME}]\nurl = ${tomlString(serverUrl)}\nbearer_token_env_var = ${tomlString("GROVE_MCP_TOKEN")}`;
  const exp = `export GROVE_MCP_TOKEN=${shellQuote(token)}`;
  return {
    steps: [
      ...tokenStep,
      { text: "Add this to ~/.codex/config.toml. The file only names the variable; it never holds the token.", copy: toml },
      { text: "Set the variable in the shell that launches Codex (add it to your shell profile to keep it).", copy: exp },
    ],
    snippets: [{ label: "~/.codex/config.toml", language: "toml", code: toml }, { label: "Environment variable", language: "bash", code: exp, hasToken }],
    noDeeplinkReason: "Codex uses config or commands instead of a link.",
    notes: ["codex mcp add has no documented flag for a bearer token, so use config.toml."],
  };
};
