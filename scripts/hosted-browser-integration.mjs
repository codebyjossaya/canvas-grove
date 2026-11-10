import crypto from "node:crypto";
import { connect as connectTcp } from "node:net";

const base = process.env.BROWSER_ORCHESTRATOR_URL?.replace(/\/$/, "");
const secret = process.env.BROWSER_ORCHESTRATOR_SECRET;
const canvasOrigin = (process.env.CANVAS_TEST_ORIGIN || "https://canvas.instructure.com").replace(/\/$/, "");
// Mirrors isValidCanvasLoginPath in lib/canvas/institution.ts.
const CANVAS_LOGIN_PATH = /^\/login(?:\/(?:saml|cas|openid_connect|microsoft|google|apple|linkedin|github|facebook|clever|ldap|canvas|instructure)(?:\/\d{1,12})?)?$/;
const loginPath = CANVAS_LOGIN_PATH.test(process.env.CANVAS_TEST_LOGIN_PATH || "") ? process.env.CANVAS_TEST_LOGIN_PATH : "/login";
const authHostRules = (process.env.CANVAS_TEST_AUTH_DOMAINS || "").split(",").map((value) => value.trim()).filter(Boolean);
const viewerOrigin = process.env.BROWSER_TEST_PUBLIC_ORIGIN || "";
if (!base || !secret) throw new Error("Browser integration environment is unavailable");

async function call(method, path, body, validSignature = true) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Date.now()); const nonce = crypto.randomBytes(16).toString("base64url");
  const signature = validSignature ? crypto.createHmac("sha256", secret)
    .update(`${method}\n${path}\n${timestamp}\n${nonce}\n${raw}`).digest("base64url") : "invalid-signature";
  const response = await fetch(`${base}${path}`, { method, redirect: "manual", body: raw || undefined,
    headers: { "content-type": "application/json", "x-orchestrator-timestamp": timestamp,
      "x-orchestrator-nonce": nonce, "x-orchestrator-signature": signature } });
  const value = await response.json().catch(() => ({})); return { response, value };
}

async function verifyViewerModuleGraph(location, cookie) {
  const root = new URL(location, base);
  const prefix = root.pathname.slice(0, root.pathname.lastIndexOf("/") + 1);
  const queued = [root];
  const seen = new Set();
  const failures = [];
  while (queued.length && seen.size < 250) {
    const batch = queued.splice(0, 20).filter((url) => !seen.has(url.href));
    batch.forEach((url) => seen.add(url.href));
    await Promise.all(batch.map(async (url) => {
      const response = await fetch(url, { headers: { cookie } });
      if (!response.ok) { failures.push({ path: url.pathname, status: response.status }); return; }
      const type = response.headers.get("content-type") || "";
      if (!/(html|javascript|css)/.test(type)) return;
      const source = await response.text();
      const references = [
        ...source.matchAll(/(?:src|href)=["']([^"'#]+)["']/g),
        ...source.matchAll(/(?:import|export)(?:[\s\S]*?from\s*)?["']([^"']+)["']/g),
        ...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);
      for (const reference of references) {
        try {
          const target = new URL(reference, url);
          if (target.origin === root.origin && target.pathname.startsWith(prefix) && !target.pathname.endsWith("/websockify") && !seen.has(target.href)) queued.push(target);
        } catch { /* An invalid optional asset reference is not a request. */ }
      }
    }));
  }
  return { count: seen.size, failures, tightPngLoaded: [...seen].some((url) => url.endsWith("/core/decoders/tightpng.js")) };
}

async function verifyFramebuffer(path, cookie) {
  const target = new URL(base); const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve) => {
    const socket = connectTcp({ host: target.hostname, port: Number(target.port || 80) });
    let wire = Buffer.alloc(0); let stream = Buffer.alloc(0); let upgraded = false; let settled = false; let stage = 0; let serverInit; let framebufferAttempts = 0;
    const finish = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    const send = (payload) => { const mask = crypto.randomBytes(4); const header = Buffer.from([0x82, 0x80 | payload.length]); const masked = Buffer.from(payload); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]; socket.write(Buffer.concat([header, mask, masked])); };
    const advance = () => {
      if (stage === 0 && stream.length >= 12) { const version = stream.subarray(0, 12); stream = stream.subarray(12); if (!version.toString().startsWith("RFB ")) return finish({ ok: false }); send(version); stage = 1; }
      if (stage === 1 && stream.length >= 1) { const count = stream[0]; if (stream.length < 1 + count) return; const types = stream.subarray(1, 1 + count); stream = stream.subarray(1 + count); if (!types.includes(1)) return finish({ ok: false }); send(Buffer.from([1])); stage = 2; }
      if (stage === 2 && stream.length >= 4) { const result = stream.readUInt32BE(0); stream = stream.subarray(4); if (result !== 0) return finish({ ok: false }); send(Buffer.from([1])); stage = 3; }
      if (stage === 3 && stream.length >= 24) { const width = stream.readUInt16BE(0); const height = stream.readUInt16BE(2); const bytesPerPixel = stream[4] / 8; const nameLength = stream.readUInt32BE(20); if (stream.length < 24 + nameLength) return; stream = stream.subarray(24 + nameLength); serverInit = { width, height, bytesPerPixel }; send(Buffer.from([2,0,0,1,0,0,0,0])); const request = Buffer.alloc(10); request[0]=3; request.writeUInt16BE(width,6); request.writeUInt16BE(height,8); send(request); stage = 4; }
      if (stage === 4 && stream.length >= 16) { if (stream[0] !== 0) return; const rectangles=stream.readUInt16BE(2); if (rectangles < 1) return finish({ ok:false,...serverInit }); const width=stream.readUInt16BE(8),height=stream.readUInt16BE(10),encoding=stream.readInt32BE(12); if(encoding!==0) return finish({ok:false,...serverInit}); const bytes=width*height*serverInit.bytesPerPixel; if(stream.length<16+bytes)return; const pixels=stream.subarray(16,16+bytes); stream=stream.subarray(16+bytes); const samples=new Set(); const stride=serverInit.bytesPerPixel*10; for(let i=0;i+serverInit.bytesPerPixel<=pixels.length;i+=stride)samples.add(pixels.subarray(i,i+serverInit.bytesPerPixel).toString('hex')); framebufferAttempts+=1; if(samples.size<=1&&framebufferAttempts<5){const request=Buffer.alloc(10);request[0]=3;request.writeUInt16BE(serverInit.width,6);request.writeUInt16BE(serverInit.height,8);setTimeout(()=>send(request),1500);return;} return finish({ok:true,width:serverInit.width,height:serverInit.height,nonblank:samples.size>1,pixelVariants:samples.size,attempts:framebufferAttempts}); }
    };
    const frames = () => { while (wire.length >= 2) { const first = wire[0], second = wire[1]; let length = second & 0x7f, offset = 2; if (length === 126) { if (wire.length < 4) return; length = wire.readUInt16BE(2); offset = 4; } else if (length === 127) { if (wire.length < 10) return; length = Number(wire.readBigUInt64BE(2)); offset = 10; } if (wire.length < offset + length) return; const payload = wire.subarray(offset, offset + length); wire = wire.subarray(offset + length); if ((first & 0x0f) === 2 || (first & 0x0f) === 0) stream = Buffer.concat([stream, payload]); advance(); } };
    socket.setTimeout(20_000, () => finish({ ok: false, ...serverInit }));
    socket.once("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\n${viewerOrigin ? `Origin: ${viewerOrigin}\r\n` : ""}Cookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`));
    socket.on("data", (chunk) => { wire = Buffer.concat([wire, chunk]); if (!upgraded) { const end = wire.indexOf("\r\n\r\n"); if (end < 0) return; if (!wire.subarray(0, end).includes("101 Switching Protocols")) return finish({ ok: false }); wire = wire.subarray(end + 4); upgraded = true; } frames(); });
    socket.once("error", () => finish({ ok: false })); socket.once("close", () => finish({ ok: false, ...serverInit }));
  });
}

const checks = {};
const diagnostics = {};
let id;
try {
  const unauthorized = await call("GET", "/v1/sessions/not-a-session", undefined, false);
  checks.badSignatureRejected = unauthorized.response.status === 401;
  const requestedDisplay = process.env.TEST_DISPLAY_WIDTH && process.env.TEST_DISPLAY_HEIGHT ? { width: Number(process.env.TEST_DISPLAY_WIDTH), height: Number(process.env.TEST_DISPLAY_HEIGHT) } : undefined;
  const created = await call("POST", "/v1/sessions", { canvasOrigin, authHostRules, loginPath, display: requestedDisplay });
  if (created.response.status !== 201) throw new Error(`Session creation failed: HTTP ${created.response.status} ${String(created.value.code || "UNKNOWN")}`);
  id = created.value.id;
  const status = await call("GET", `/v1/sessions/${id}`);
  checks.statusRunning = status.value.state === "running";
  const blocked = await call("POST", `/v1/sessions/${id}/navigate`, { url: "https://example.com/" });
  checks.unexpectedOriginRejected = blocked.response.status === 400 && blocked.value.code === "NAVIGATION_BLOCKED";
  const navigated = await call("POST", `/v1/sessions/${id}/navigate`, { url: `${canvasOrigin}${loginPath}` });
  diagnostics.navigate = { status: navigated.response.status, code: navigated.value.code || null };
  checks.samlNavigationAccepted = navigated.response.ok;
  const connected = await call("GET", `/v1/sessions/${id}/connect`);
  checks.cdpConnected = connected.response.ok && typeof connected.value.cdpUrl === "string";
  let urls = []; let targets = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt === 20) await call("POST", `/v1/sessions/${id}/navigate`, { url: `${canvasOrigin}${loginPath}` });
    targets = await fetch(`${connected.value.cdpUrl}/json/list`).then((response) => response.json());
    urls = targets.map((target) => target.url).filter((url) => url.startsWith("https://"));
    if (urls.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const visibleTarget = targets.find((target) => target.url?.startsWith("https://"));
  if (visibleTarget?.id) {
    const activated = await fetch(`${connected.value.cdpUrl}/json/activate/${encodeURIComponent(visibleTarget.id)}`);
    checks.institutionTargetActivated = activated.ok;
  } else checks.institutionTargetActivated = false;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  diagnostics.visible = { hosts: urls.map((value) => new URL(value).hostname) };
  checks.finalOriginAllowed = urls.some((value) => { const host = new URL(value).hostname; const canvasHost = new URL(canvasOrigin).hostname; return host === canvasHost || authHostRules.some((rule) => host === rule || host.endsWith(`.${rule}`)); });
  const live = await call("POST", `/v1/sessions/${id}/live`);
  checks.liveExpiryBounded = live.value.expiresAt > Date.now() && live.value.expiresAt <= Date.now() + 301_000;
  const livePath = new URL(live.value.url, base).pathname;
  const first = await fetch(`${base}${livePath}`, { redirect: "manual" });
  const cookie = first.headers.get("set-cookie")?.split(";")[0] || "";
  let viewer;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    viewer = await fetch(`${base}${first.headers.get("location")}`, { headers: { cookie } });
    if (viewer.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const reused = await fetch(`${base}${livePath}`, { redirect: "manual" });
  diagnostics.live = `${first.status}/${viewer?.status ?? 0}/${reused.status}`;
  checks.liveViewInteractive = first.status === 302 && viewer?.status === 200;
  const viewerLocation = new URL(first.headers.get("location"), base);
  const moduleGraph = await verifyViewerModuleGraph(viewerLocation, cookie);
  diagnostics.moduleGraph = moduleGraph;
  checks.viewerModuleGraphComplete = moduleGraph.count >= 30 && moduleGraph.failures.length === 0 && moduleGraph.tightPngLoaded;
  const framebuffer = await verifyFramebuffer(`/${viewerLocation.searchParams.get("path")}`, cookie);
  diagnostics.framebuffer = framebuffer;
  checks.liveFramebufferReceived = framebuffer.ok;
  checks.framebufferDimensions = !requestedDisplay || (framebuffer.width === requestedDisplay.width && framebuffer.height === requestedDisplay.height);
  checks.institutionLoginFramebufferNonblank = framebuffer.ok && framebuffer.nonblank;
  checks.kioskGeometry = checks.framebufferDimensions;
  checks.oneTimeReuseRejected = reused.status === 410;
  const revoked = await call("POST", `/v1/sessions/${id}/revoke-live`);
  const oldGrant = await fetch(viewerLocation, { headers: { cookie } });
  const replacementLive = await call("POST", `/v1/sessions/${id}/live`);
  const replacementRedeem = await fetch(new URL(replacementLive.value.url, base), { redirect: "manual" });
  const replacementCookie = replacementRedeem.headers.get("set-cookie")?.split(";")[0] || "";
  const replacementLocation = new URL(replacementRedeem.headers.get("location"), base);
  const replacementViewer = await fetch(replacementLocation, { headers: { cookie: replacementCookie } });
  const replacementGraph = await verifyViewerModuleGraph(replacementLocation, replacementCookie);
  const replacementFramebuffer = await verifyFramebuffer(`/${replacementLocation.searchParams.get("path")}`, replacementCookie);
  diagnostics.reconnect = { revoked: revoked.response.status, oldGrant: oldGrant.status, redeem: replacementRedeem.status,
    viewer: replacementViewer.status, modules: replacementGraph.count, moduleFailures: replacementGraph.failures, framebuffer: replacementFramebuffer };
  checks.revokeInvalidatesOldGrant = revoked.response.ok && oldGrant.status === 401;
  checks.reconnectIssuesWorkingFreshGrant = replacementRedeem.status === 302 && replacementViewer.status === 200 &&
    replacementGraph.count >= 30 && replacementGraph.failures.length === 0 && replacementFramebuffer.ok && replacementFramebuffer.nonblank;
  const holdMs = Number(process.env.TEST_HOLD_MS || 0);
  if (holdMs > 0) {
    const samples = []; const deadline = Date.now() + holdMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, deadline - Date.now())));
      const sample = await call("GET", `/v1/sessions/${id}`);
      samples.push({ at: new Date().toISOString(), running: sample.response.ok && sample.value.state === "running" });
    }
    diagnostics.hold = { id, durationMs: holdMs, samples };
    checks.stableDuringHold = samples.length >= 4 && samples.every((sample) => sample.running);
  }
} finally {
  if (id) {
    const terminated = await call("DELETE", `/v1/sessions/${id}`);
    checks.terminated = terminated.response.ok;
    const missing = await call("GET", `/v1/sessions/${id}`);
    checks.cleanupConfirmed = missing.response.status === 404;
  }
}
if (Object.values(checks).some((value) => value !== true)) throw new Error(`Integration checks failed: ${Object.keys(checks).filter((key) => checks[key] !== true).join(",")}; navigate=${JSON.stringify(diagnostics.navigate ?? {})}; live=${diagnostics.live ?? "unknown"}; framebuffer=${JSON.stringify(diagnostics.framebuffer ?? {})}; visible=${JSON.stringify(diagnostics.visible ?? {})}`);
console.log(JSON.stringify({ checks, diagnostics }));
