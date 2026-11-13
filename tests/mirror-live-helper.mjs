// Integration helper for tests/mirror-live.integration.test.mjs. Runs INSIDE the
// orchestrator container (piped to `node --input-type=module`), so the
// orchestrator secret never leaves the container and is never printed. Prints
// one JSON line. Usage: set MIRROR_HELPER_ARGS to a JSON array:
//   ["create", canvasOrigin, authHostRules[], display{}, loginUrl]
//   ["live", sessionId]            -> one-time /live/<token> path
//   ["eval", sessionId, expression] -> value from the remote's newest page (CDP)
//   ["shot", sessionId]             -> base64 PNG of the remote page
//   ["delete", sessionId]
import { createHmac, randomBytes } from "node:crypto";

const BASE = "http://127.0.0.1:8080";
const SECRET = process.env.BROWSER_ORCHESTRATOR_SECRET || "";
const args = JSON.parse(process.env.MIRROR_HELPER_ARGS || "[]");

async function api(method, path, value) {
  const raw = value === undefined ? "" : JSON.stringify(value), timestamp = String(Date.now()), nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${raw}`).digest("base64url");
  const response = await fetch(`${BASE}${path}`, { method, body: raw || undefined, headers: { "content-type": "application/json", "x-orchestrator-timestamp": timestamp, "x-orchestrator-nonce": nonce, "x-orchestrator-signature": signature } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/, "<id>")}: ${response.status} ${result.code || ""}`);
  return result;
}

async function cdp(sessionId, method, params) {
  const { cdpUrl } = await api("GET", `/v1/sessions/${sessionId}/connect`);
  const list = await fetch(`${cdpUrl}/json/list`).then((response) => response.json());
  const page = list.filter((item) => item.type === "page" && item.url !== "about:blank").at(-1) || list.find((item) => item.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp timeout")), 15_000);
    socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id === 1) { clearTimeout(timer); resolve(message.result || { error: message.error }); } });
    socket.send(JSON.stringify({ id: 1, method, params }));
  });
  socket.close();
  return result;
}

const [command, ...rest] = args;
let out;
if (command === "create") {
  const [canvasOrigin, authHostRules, display, loginUrl] = rest;
  const created = await api("POST", "/v1/sessions", { canvasOrigin, authHostRules, display });
  await api("POST", `/v1/sessions/${created.id}/navigate`, { url: loginUrl });
  out = { id: created.id };
} else if (command === "live") {
  out = await api("POST", `/v1/sessions/${rest[0]}/live`, {});
} else if (command === "eval") {
  const result = await cdp(rest[0], "Runtime.evaluate", { expression: rest[1], returnByValue: true });
  out = { value: result?.result?.value ?? null };
} else if (command === "shot") {
  const result = await cdp(rest[0], "Page.captureScreenshot", { format: "png" });
  out = { png: result?.data || null };
} else if (command === "delete") {
  out = await api("DELETE", `/v1/sessions/${rest[0]}`).catch((error) => ({ error: error.message }));
} else out = { error: "unknown command" };
process.stdout.write(`${JSON.stringify(out)}\n`);
