import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS, agentsFor, needsToken, getAgent, type AgentId } from "../lib/connect-agent/catalog";
import { fromBase64Utf8, normalizeServerUrl, shellQuote, toBase64Utf8, tomlString } from "../lib/connect-agent/encode";
import { buildPrompt, guideFor } from "../lib/connect-agent/guides";

const URL_ = "https://grove.example.com/mcp";
const TOKEN = "gmt1.owner-id.token-id.s3cr3t-value_with+odd/chars=";

test("every agent builds a guide in each supported mode", () => {
  for (const agent of AGENTS) for (const mode of ["oauth", "token"] as const) {
    const guide = guideFor(agent.id, { serverUrl: URL_, mode });
    assert.ok(guide.steps.length > 0 && guide.snippets.length > 0, agent.id);
    assert.equal(guide.mode, agent.auth === "either" ? mode : agent.auth);
  }
});

test("filters by workflow", () => {
  assert.deepEqual(agentsFor("all").length, AGENTS.length);
  assert.ok(agentsFor("ide").every(a => a.workflows.includes("ide")));
  assert.ok(agentsFor("terminal").some(a => a.id === "claude-code"));
});

test("needsToken follows auth support and chosen mode", () => {
  assert.equal(needsToken(getAgent("claude")!), false);
  assert.equal(needsToken(getAgent("vscode")!), true);
  assert.equal(needsToken(getAgent("cursor")!, "oauth"), false);
  assert.equal(needsToken(getAgent("cursor")!, "token"), true);
});

test("cursor deeplink decodes to the intended config and has no token", () => {
  const guide = guideFor("cursor", { serverUrl: URL_, token: TOKEN, mode: "oauth" });
  const link = new URL(guide.deeplink!.href);
  assert.equal(link.protocol, "cursor:");
  assert.equal(link.host + link.pathname, "anysphere.cursor-deeplink/mcp/install");
  assert.equal(link.searchParams.get("name"), "canvas-grove");
  const config = JSON.parse(Buffer.from(link.searchParams.get("config")!, "base64").toString("utf8"));
  assert.deepEqual(config, { url: URL_ });
  assert.ok(!guide.deeplink!.href.includes("gmt1"));
});

test("token mode never produces a deeplink; tokens never appear in any link", () => {
  for (const agent of AGENTS) {
    const guide = guideFor(agent.id, { serverUrl: URL_, token: TOKEN, mode: "token" });
    assert.equal(guide.deeplink, undefined, agent.id);
  }
  for (const agent of AGENTS) {
    const g = guideFor(agent.id, { serverUrl: URL_, token: TOKEN });
    if (g.deeplink) assert.ok(!g.deeplink.href.includes(TOKEN));
  }
});

test("token is substituted into token-mode snippets only, as a placeholder otherwise", () => {
  const without = guideFor("claude-code", { serverUrl: URL_, mode: "token" });
  assert.ok(without.snippets[0].code.includes("<YOUR_GROVE_TOKEN>"));
  assert.ok(!without.snippets[0].hasToken);
  const withToken = guideFor("claude-code", { serverUrl: URL_, mode: "token", token: TOKEN });
  assert.ok(withToken.snippets[0].code.includes(TOKEN) && withToken.snippets[0].hasToken);
  assert.ok(withToken.snippets[0].code.includes("--header 'Authorization: Bearer "));
  const oauth = guideFor("claude-code", { serverUrl: URL_, mode: "oauth", token: TOKEN });
  assert.ok(!JSON.stringify(oauth).includes(TOKEN));
});

test("json snippets parse back to the intended config", () => {
  const cursor = guideFor("cursor", { serverUrl: URL_, mode: "token", token: TOKEN });
  assert.deepEqual(JSON.parse(cursor.snippets[0].code), { mcpServers: { "canvas-grove": { url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } } });
  const vscode = guideFor("vscode", { serverUrl: URL_, token: TOKEN });
  const parsed = JSON.parse(vscode.snippets[0].code);
  assert.deepEqual(Object.keys(parsed), ["servers"]);
  assert.equal(parsed.servers["canvas-grove"].type, "http");
  const gemini = guideFor("gemini", { serverUrl: URL_, mode: "token", token: TOKEN });
  assert.equal(JSON.parse(gemini.snippets[1].code).mcpServers["canvas-grove"].httpUrl, URL_);
});

test("shell snippets survive quoting round trips", () => {
  assert.equal(shellQuote("abc"), "abc");
  assert.equal(shellQuote("a b'c"), `'a b'\\''c'`);
  const guide = guideFor("vscode", { serverUrl: URL_, token: "tok'en", mode: "token" });
  const cmd = guide.snippets[1].code;
  assert.ok(cmd.startsWith("code --add-mcp '"));
  const payload = cmd.slice("code --add-mcp ".length).slice(1, -1).replace(/'\\''/g, "'");
  assert.equal(JSON.parse(payload).headers.Authorization, "Bearer tok'en");
});

test("codex toml references an env var and parses as intended", () => {
  const guide = guideFor("codex", { serverUrl: URL_, mode: "token", token: TOKEN });
  const toml = guide.snippets[0].code;
  assert.ok(!toml.includes(TOKEN));
  assert.match(toml, /^\[mcp_servers\.canvas-grove\]\nurl = "https:\/\/grove\.example\.com\/mcp"\nbearer_token_env_var = "GROVE_MCP_TOKEN"$/);
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.ok(guide.snippets[1].code.startsWith("export GROVE_MCP_TOKEN="));
});

test("base64 utf8 round trip and url validation", () => {
  const text = JSON.stringify({ url: "https://exämple.com/mcp?x=1&y=é" });
  assert.equal(fromBase64Utf8(toBase64Utf8(text)), text);
  assert.equal(toBase64Utf8(text), Buffer.from(text, "utf8").toString("base64"));
  assert.equal(normalizeServerUrl("https://a.example/mcp/"), "https://a.example/mcp");
  assert.throws(() => normalizeServerUrl("javascript:alert(1)"));
  assert.throws(() => normalizeServerUrl("not a url"));
});

test("prompt contains the server URL and OAuth instructions and never a token", () => {
  const prompt = buildPrompt({ serverUrl: URL_ });
  assert.ok(prompt.includes(URL_) && /OAuth/.test(prompt));
  const sneaky = buildPrompt({ serverUrl: URL_, token: TOKEN } as { serverUrl: string });
  assert.ok(!sneaky.includes(TOKEN) && !/gmt1\./.test(sneaky) && !/Bearer/.test(sneaky));
});

test("guides never leak tokens into agents that are OAuth-only", () => {
  for (const id of ["claude", "chatgpt"] as AgentId[]) assert.ok(!JSON.stringify(guideFor(id, { serverUrl: URL_, token: TOKEN })).includes(TOKEN));
});
