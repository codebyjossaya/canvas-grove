import { SERVER_NAME } from "./catalog";
import { jsonBlock, toBase64Utf8 } from "./encode";
import type { Builder } from "./types";

const bearer = (token: string) => `Bearer ${token}`;

export const claude: Builder = (_mode, { serverUrl }) => ({
  steps: [
    { text: "Open Claude (claude.ai or Claude Desktop) and go to Customize > Connectors." },
    { text: "Click + Add, then Add custom connector." },
    { text: "Name it Canvas Grove and paste the server URL.", copy: serverUrl },
    { text: "Leave authentication on OAuth and finish adding it, then click Connect and approve access on the Grove sign-in page." },
  ],
  snippets: [{ label: "Server URL", language: "text", code: serverUrl }],
  noDeeplinkReason: "Claude has no documented one-click link for custom connectors.",
  notes: [
    "Free plans allow one custom connector. On Team and Enterprise plans an Owner adds it under Organization settings > Connectors, then each member clicks Connect.",
    "Claude connects from Anthropic's servers, so Grove must be reachable on the public internet.",
    "Anthropic's help article describes the web app and gives no separate Claude Desktop steps; Desktop uses the same account connectors.",
  ],
});

export const chatgpt: Builder = (_mode, { serverUrl }) => ({
  steps: [
    { text: "In ChatGPT, open Settings > Connectors (labelled Apps or Apps & Connectors on some plans) and turn on Developer mode under Advanced settings." },
    { text: "Create a new custom MCP connector (the button is labelled Create or Add custom connector depending on your plan)." },
    { text: "Name it Canvas Grove and paste the server URL.", copy: serverUrl },
    { text: "Choose OAuth for authentication, save, then sign in to Grove when asked." },
  ],
  snippets: [{ label: "Server URL", language: "text", code: serverUrl }],
  noDeeplinkReason: "ChatGPT has no one-click link for custom connectors.",
  notes: [
    "Unverified: OpenAI's own help pages could not be read when this guide was written. Menu names come from third-party guides and may differ on your plan.",
    "Developer mode availability depends on your plan; on Business plans a workspace admin may need to enable it.",
  ],
});

export const claudeCode: Builder = (mode, { url, header, hasToken, tokenStep }) => {
  if (mode === "oauth") {
    const add = `claude mcp add --transport http ${SERVER_NAME} ${url}`;
    return {
      steps: [
        { text: "Add Grove as an HTTP server.", copy: add },
        { text: "Start Claude Code, run /mcp, pick canvas-grove and follow the browser sign-in.", copy: "/mcp" },
        { text: "Or sign in from your shell.", copy: `claude mcp login ${SERVER_NAME}` },
      ],
      snippets: [{ label: "Add server (OAuth)", language: "bash", code: add }],
      noDeeplinkReason: "Claude Code uses a command instead of a link.",
      notes: ["Add --scope user to make it available in every project (the default, local, is this project only)."],
    };
  }
  const cmd = `claude mcp add --transport http ${SERVER_NAME} ${url} \\\n  --header ${header}`;
  return {
    steps: [...tokenStep, { text: "Run this command. It stores the token in your Claude Code config.", copy: cmd }, { text: "Run /mcp inside Claude Code and check canvas-grove shows as connected.", copy: "/mcp" }],
    snippets: [{ label: "Add server (token)", language: "bash", code: cmd, hasToken }],
    noDeeplinkReason: "Token installs never use links, so your token cannot end up in a URL.",
    notes: ["Claude Code saves the command without checking the token, so a wrong token only fails when it connects."],
  };
};

export const cursor: Builder = (mode, { serverUrl, token, hasToken, tokenStep }) => {
  if (mode === "oauth") {
    const config = jsonBlock({ mcpServers: { [SERVER_NAME]: { url: serverUrl } } });
    const b64 = toBase64Utf8(JSON.stringify({ url: serverUrl }));
    const href = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(b64)}`;
    return {
      steps: [
        { text: "Click Install in Cursor below. Cursor asks you to confirm the server." },
        { text: "Choose Connect on the canvas-grove entry and sign in to Grove in the browser." },
        { text: "Prefer a file? Put this in .cursor/mcp.json (project) or ~/.cursor/mcp.json (all projects).", copy: config },
      ],
      snippets: [{ label: ".cursor/mcp.json", language: "json", code: config }],
      deeplink: { label: "Install in Cursor", href },
      notes: [
        "Cursor documents the link as name plus base64-encoded JSON of the server entry. Its docs show no example for a remote URL server, so the entry uses the mcp.json shape (url only).",
        "Cursor users report the install card sometimes not appearing after UI changes. If so, use the file.",
      ],
    };
  }
  const config = jsonBlock({ mcpServers: { [SERVER_NAME]: { url: serverUrl, headers: { Authorization: bearer(token) } } } });
  return {
    steps: [...tokenStep, { text: "Put this in .cursor/mcp.json (project) or ~/.cursor/mcp.json (all projects).", copy: config }, { text: "Open Cursor Settings and check canvas-grove is enabled." }],
    snippets: [{ label: ".cursor/mcp.json (token)", language: "json", code: config, hasToken }],
    noDeeplinkReason: "Token installs never use links, so your token cannot end up in a URL.",
    notes: ["Do not commit a file that contains your token. Prefer the user-level ~/.cursor/mcp.json."],
  };
};
