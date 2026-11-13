# Connect agent: client formats and sources

Checked 2026-11-12. Code: `lib/connect-agent/**` (guides), `components/workspace/connect-agent/**` (UI).
Logos: `public/agent-logos` (see NOTICE.md there). VS Code has no logo, so its card uses the GitHub Copilot mark.

| Client | Auth in our guide | Verified | Source |
| --- | --- | --- | --- |
| Claude (claude.ai / Desktop) | OAuth, URL only | Yes (web app steps). No separate Desktop steps in the article. | support.claude.com/en/articles/11175166 |
| ChatGPT | OAuth, URL only | NO. Official OpenAI pages were blocked (403/404); menu names from third-party guides. UI says so. | developers.openai.com (unreadable) |
| Claude Code | OAuth or `--header "Authorization: Bearer ..."` | Yes: `claude mcp add --transport http`, `--header`, `/mcp`, `claude mcp login`, `--scope` | code.claude.com/docs/en/mcp |
| Cursor | OAuth (link or file) or token in `headers` | Partly. `.cursor/mcp.json` + `~/.cursor/mcp.json`, `url`/`headers`: yes. Deeplink = `name` + base64(JSON.stringify(entry)): yes. No remote-URL example in the docs, so the entry is `{url}`; URL-encoding of the base64 is not stated (we encode it). | cursor.com/docs/context/mcp, cursor.com/docs/context/mcp/install-links |
| VS Code | Token (OAuth unconfirmed) | Partly. `.vscode/mcp.json` with root `servers`, `type: http`: yes. `code --add-mcp '{json with name}'`: yes. `vscode:mcp/install` link: NOT in official docs (third-party only) so omitted. | code.visualstudio.com/docs/agents/reference/mcp-configuration |
| Codex CLI | OAuth (`codex mcp login`) or `bearer_token_env_var` | Yes for config.toml keys, login, `--url`. Unverified: `codex mcp add --url` without `--oauth-client-id`; the `~/.codex/config.toml` path (page only says config.toml). | learn.chatgpt.com/docs/extend/mcp (redirect from developers.openai.com/codex/mcp) |
| Gemini CLI | OAuth discovery (`/mcp auth`) or `--header` | Yes: `gemini mcp add --transport http`, `-H/--header`, `httpUrl`, `headers`, `-s`, paths | github.com/google-gemini/gemini-cli docs/tools/mcp-server.md |
| Other | Either | Generic: key names differ per client | n/a |

## Rules
* The prompt (`buildPrompt`) takes no token and contains none.
* Tokens exist only in React state while the dialog is open and are substituted into snippets in memory. They are never put in a URL, storage, or log. Deeplinks are only built in OAuth mode.
* Server URL comes from `GET /api/canvas/mcp/connections` (`serverUrl`), falling back to `origin + "/mcp"`.

## Not verified
ChatGPT UI steps; Cursor remote deeplink payload and base64 URL-encoding; VS Code install link and OAuth support; `codex mcp add --url` without a client id.
