import { SERVER_NAME } from "./catalog";
import { jsonBlock } from "./encode";
import type { Builder } from "./types";

const KEY_NOTE = "Key names vary by client (mcpServers, servers, httpUrl, serverUrl). Check your client's docs.";

export const gemini: Builder = (mode, { url, header, token, hasToken, tokenStep, serverUrl }) => {
  if (mode === "oauth") {
    const cmd = `gemini mcp add --transport http ${SERVER_NAME} ${url}`;
    return {
      steps: [{ text: "Add the server.", copy: cmd }, { text: "Start Gemini CLI and authenticate from inside the session.", copy: `/mcp auth ${SERVER_NAME}` }],
      snippets: [{ label: "Add server (OAuth)", language: "bash", code: cmd }],
      noDeeplinkReason: "Gemini CLI uses a command instead of a link.",
      notes: ["gemini mcp add saves to the project (.gemini/settings.json) by default; add -s user for ~/.gemini/settings.json.", "Gemini CLI discovers OAuth automatically when the server supports it."],
    };
  }
  const cmd = `gemini mcp add --transport http --header ${header} ${SERVER_NAME} ${url}`;
  const json = jsonBlock({ mcpServers: { [SERVER_NAME]: { httpUrl: serverUrl, headers: { Authorization: `Bearer ${token}` } } } });
  return {
    steps: [...tokenStep, { text: "Add the server with your token.", copy: cmd }, { text: "Or edit ~/.gemini/settings.json (user) or .gemini/settings.json (project) by hand.", copy: json }],
    snippets: [{ label: "Add server (token)", language: "bash", code: cmd, hasToken }, { label: "settings.json", language: "json", code: json, hasToken }],
    noDeeplinkReason: "Gemini CLI uses a command instead of a link.",
    notes: ["Token installs never use links, so your token cannot end up in a URL."],
  };
};

export const other: Builder = (mode, { serverUrl, token, hasToken, tokenStep }) => {
  if (mode === "oauth") {
    const json = jsonBlock({ mcpServers: { [SERVER_NAME]: { url: serverUrl } } });
    return {
      steps: [
        { text: "Add a remote (Streamable HTTP) MCP server in your client and paste this URL.", copy: serverUrl },
        { text: "Choose OAuth if asked. Grove advertises its sign-in at /.well-known/oauth-authorization-server and supports dynamic client registration." },
      ],
      snippets: [{ label: "Server URL", language: "text", code: serverUrl }, { label: "Generic JSON", language: "json", code: json }],
      noDeeplinkReason: "Every client differs, so there is no generic link.",
      notes: [KEY_NOTE],
    };
  }
  const json = jsonBlock({ mcpServers: { [SERVER_NAME]: { url: serverUrl, headers: { Authorization: `Bearer ${token}` } } } });
  return {
    steps: [
      ...tokenStep,
      { text: "Add a remote (Streamable HTTP) MCP server and paste this URL.", copy: serverUrl },
      { text: "Send the token as a header on every request (Authorization: Bearer <token>), or paste the generic JSON.", copy: json },
    ],
    snippets: [{ label: "Server URL", language: "text", code: serverUrl }, { label: "Generic JSON (token)", language: "json", code: json, hasToken }],
    noDeeplinkReason: "Every client differs, so there is no generic link.",
    notes: [KEY_NOTE],
  };
};
