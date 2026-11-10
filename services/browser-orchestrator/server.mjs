import { createServer, request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { posix as path } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyManagedContainer } from "./orphan-policy.mjs";
import { allowedInteractiveUrl } from "./navigation-policy.mjs";
import { mobileLaunchEnv, validDisplay } from "./display-policy.mjs";

const run = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.BROWSER_ORCHESTRATOR_SECRET || "";
const IMAGE = process.env.BROWSER_IMAGE || "canvas-browser:local";
const NETWORK = process.env.BROWSER_NETWORK || "canvas-browser-quarantine";
const RELAY_CONTAINER = "canvas-browser-relay", EGRESS_PROXY_CONTAINER = "canvas-browser-egress-proxy";
const PUBLIC_BASE = (process.env.BROWSER_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const IDLE_TTL_MS = Math.min(Number(process.env.BROWSER_IDLE_TTL_SECONDS || 1800), 21600) * 1000;
const MAX_SESSIONS = Math.max(1, Number(process.env.BROWSER_MAX_SESSIONS || 8));
const WARM_POOL_SIZE = Math.min(Math.max(0, Number(process.env.BROWSER_WARM_POOL_SIZE || 2)), 3);
const REGISTRY_PATH = process.env.BROWSER_REGISTRY_PATH || "/var/lib/canvas-grove/registry.json";
const RELAY_URL = (process.env.BROWSER_RELAY_URL || "http://browser-relay:8081").replace(/\/$/, "");
const RELAY_SECRET = process.env.BROWSER_RELAY_SECRET || "";
const relayOrigin = new URL(RELAY_URL);
const NOVNC_ROOT = process.env.NOVNC_ROOT || "/usr/share/novnc";
const VIEWER_ROOT = process.env.VIEWER_ROOT || new URL("./viewer", import.meta.url).pathname;
const ORPHAN_GRACE_MS = Math.max(300, Number(process.env.BROWSER_ORPHAN_GRACE_SECONDS || 600)) * 1000;
const DEFAULT_DISPLAY = { width: 1280, height: 720 };
class BrowserNetworkPolicyError extends Error {}
if (SECRET.length < 32) throw new Error("BROWSER_ORCHESTRATOR_SECRET must contain at least 32 characters");
if (RELAY_SECRET.length < 32 || RELAY_SECRET === SECRET) throw new Error("A distinct BROWSER_RELAY_SECRET is required");
try { const origin = new URL(PUBLIC_BASE); if (origin.protocol !== "https:" || origin.origin !== PUBLIC_BASE) throw new Error(); }
catch { throw new Error("BROWSER_PUBLIC_BASE_URL must be the exact external HTTPS origin (for this host use https://desktop-lnvmg14.tail8dc4e4.ts.net)"); }

const sessions = new Map();
const nonces = new Map();
const liveTokens = new Map();
const viewerGrants = new Map();
const viewerSockets = new Map();
const connectTokens = new Map();
const viewerAssets = new Map();
const navigationTombstones = new Map();
const removals = new Set();
const warmPool = [];
let replenishing = false;
let persisting = Promise.resolve();
let lastOwnedSessionIds;
let lastRelayEpoch, relayReconcileRunning = false;
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const equal = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const send = (res, status, value, headers = {}) => { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(body); };

async function relayRequest(method, requestPath, value) {
  const raw = value === undefined ? "" : JSON.stringify(value), timestamp = String(Date.now()), nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", RELAY_SECRET).update(`${method}\n${requestPath}\n${timestamp}\n${nonce}\n${raw}`).digest("base64url");
  const response = await fetch(`${RELAY_URL}${requestPath}`, { method, body: raw || undefined, headers: {
    "content-type": "application/json", "x-relay-timestamp": timestamp, "x-relay-nonce": nonce, "x-relay-signature": signature,
  }, signal: AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error("Browser relay request failed"); error.status = response.status; error.code = result.code; error.blockedHost = result.blockedHost; throw error; }
  return result;
}

async function registerRelaySession(session) {
  let lastError;
  // Docker DNS propagation after attaching relay, proxy, and browser to a new
  // internal network is asynchronous. Bound retries to registration only;
  // capabilities remain unavailable until the fixed target is registered.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await relayRequest("PUT", `/v1/sessions/${session.id}`, { target: session.name, canvasOrigin: session.canvasOrigin, authHostRules: session.authHostRules }); }
    catch (error) { lastError = error; if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw lastError;
}

const sessionNetworkName = (id) => `canvas-browser-net-${id}`;
async function ensureSessionNetwork(session) {
  const network = sessionNetworkName(session.id);
  await run("docker", ["network", "inspect", network], { timeout: 10_000, windowsHide: true }).catch(async () => {
    await run("docker", ["network", "create", "--internal", "--label", "canvas.browser.network=true", network], { timeout: 15_000, windowsHide: true });
  });
  const networkRaw = await run("docker", ["network", "inspect", network], { timeout: 10_000, windowsHide: true });
  const networkState = JSON.parse(networkRaw.stdout)?.[0];
  const allowedNames = new Set([RELAY_CONTAINER, EGRESS_PROXY_CONTAINER, session.name]);
  const attachedNames = Object.values(networkState?.Containers ?? {}).map((item) => item?.Name).filter(Boolean);
  if (networkState?.Internal !== true || networkState?.Driver !== "bridge" || networkState?.Labels?.["canvas.browser.network"] !== "true" || attachedNames.some((name) => !allowedNames.has(name))) {
    throw new BrowserNetworkPolicyError("Per-session browser network failed security validation");
  }
  for (const container of [RELAY_CONTAINER, EGRESS_PROXY_CONTAINER, session.name]) {
    const inspected = await run("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", container], { timeout: 10_000, windowsHide: true });
    const attached = JSON.parse(inspected.stdout || "{}");
    if (!attached[network]) await run("docker", ["network", "connect", network, container], { timeout: 10_000, windowsHide: true });
  }
  for (const legacy of [NETWORK, "canvas-browser-egress"]) {
    if (legacy !== network) await run("docker", ["network", "disconnect", legacy, session.name], { timeout: 10_000, windowsHide: true }).catch(() => undefined);
  }
  return network;
}

async function removeSessionNetwork(sessionId) {
  const network = sessionNetworkName(sessionId);
  for (const container of [RELAY_CONTAINER, EGRESS_PROXY_CONTAINER]) await run("docker", ["network", "disconnect", "-f", network, container], { timeout: 10_000, windowsHide: true }).catch(() => undefined);
  await run("docker", ["network", "rm", network], { timeout: 15_000, windowsHide: true }).catch(() => undefined);
}

async function reconcileSessionNetworks() {
  const listed = await run("docker", ["network", "ls", "--filter", "label=canvas.browser.network=true", "--format", "{{.Name}}"], { timeout: 10_000, windowsHide: true });
  // The durable registry can temporarily lag the database during restart or
  // repair. Protect both sources of ownership so GC cannot remove the network
  // needed to re-adopt a DB-owned provider.
  const protectedIds = new Set([...sessions.keys(), ...(lastOwnedSessionIds ?? [])]);
  for (const network of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = /^canvas-browser-net-([0-9a-f-]{36})$/.exec(network);
    if (!match || protectedIds.has(match[1])) continue;
    const inspected = await run("docker", ["network", "inspect", "-f", "{{.Created}}", network], { timeout: 10_000, windowsHide: true }).catch(() => ({ stdout: "" }));
    const createdAt = Date.parse(inspected.stdout.trim());
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < ORPHAN_GRACE_MS) continue;
    for (const container of [RELAY_CONTAINER, EGRESS_PROXY_CONTAINER]) await run("docker", ["network", "disconnect", "-f", network, container], { timeout: 10_000, windowsHide: true }).catch(() => undefined);
    const removed = await run("docker", ["network", "rm", network], { timeout: 15_000, windowsHide: true }).then(() => true).catch(() => false);
    if (removed) console.log(JSON.stringify({ event: "browser_orphan_network_removed", networkId: match[1] }));
  }
}

async function reconcileRelayEpoch() {
  if (relayReconcileRunning) return;
  relayReconcileRunning = true;
  try {
    const response = await fetch(`${RELAY_URL}/health`, { signal: AbortSignal.timeout(3_000), cache: "no-store" });
    const health = response.ok ? await response.json() : null;
    if (!health?.ready || typeof health.epoch !== "string") return;
    for (const session of [...sessions.values()]) {
      if (!await browserIsRunning(session)) { await forgetMissingBrowser(session); continue; }
      try { await ensureSessionNetwork(session); await registerRelaySession(session); }
      catch (error) {
        if (error instanceof BrowserNetworkPolicyError) { console.warn(JSON.stringify({ event: "browser_network_validation_failed", sessionId: session.id })); await removeBrowser(session).catch(() => undefined); }
        else console.warn(JSON.stringify({ event: "browser_network_reconcile_deferred", sessionId: session.id }));
      }
    }
    if (lastRelayEpoch !== health.epoch) console.log(JSON.stringify({ event: "browser_relay_reconciled", sessions: sessions.size }));
    lastRelayEpoch = health.epoch;
  } catch { /* Fail closed: capabilities cannot be minted while relay is unavailable. */ }
  finally { relayReconcileRunning = false; }
}

function persistRegistry() {
  const value = JSON.stringify({ version: 2, sessions: [...sessions.values()].map(({ id, name, canvasOrigin, authHostRules, loginPath, display, createdAt, lastUsedAt }) => ({ id, name, canvasOrigin, authHostRules, loginPath, display, createdAt, lastUsedAt })), warmPool });
  persisting = persisting.catch(() => undefined).then(async () => {
    const slash = REGISTRY_PATH.lastIndexOf("/"); const directory = slash > 0 ? REGISTRY_PATH.slice(0, slash) : ".";
    await mkdir(directory, { recursive: true }); const temporary = `${REGISTRY_PATH}.${process.pid}.tmp`;
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 }); await rename(temporary, REGISTRY_PATH);
  });
  return persisting;
}

async function restoreRegistry() {
  let raw;
  try { raw = await readFile(REGISTRY_PATH, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Browser registry is unavailable", { cause: error });
  }
  let stored;
  try { stored = JSON.parse(raw); }
  catch (error) { throw new Error("Browser registry is corrupt", { cause: error }); }
  if (![1, 2].includes(stored?.version) || !Array.isArray(stored.sessions) || !Array.isArray(stored.warmPool)) {
    throw new Error("Browser registry has an unsupported format");
  }
  const running = async (name) => (await run("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeout: 10_000, windowsHide: true }).catch(() => ({ stdout: "false" }))).stdout.trim() === "true";
  const currentImageId = (await run("docker", ["image", "inspect", "-f", "{{.Id}}", IMAGE], { timeout: 10_000, windowsHide: true })).stdout.trim();
  const currentImage = async (name) => (await run("docker", ["inspect", "-f", "{{.Image}}", name], { timeout: 10_000, windowsHide: true }).catch(() => ({ stdout: "" }))).stdout.trim() === currentImageId;
  for (const item of stored.sessions) {
    if (!/^[0-9a-f-]{36}$/.test(item?.id || "") || !/^canvas-browser-[a-z0-9-]+$/.test(item?.name || "") || !validOrigin(item?.canvasOrigin) || !validDisplay(item?.display) || !await running(item.name)) continue;
    const restored = { ...item, authHostRules: validAuthHostRules(item.authHostRules) ?? [], loginPath: validLoginPath(item.loginPath) ? item.loginPath : "/login", lastUsedAt: Date.now() };
    sessions.set(item.id, restored);
    await ensureSessionNetwork(restored);
    await registerRelaySession(restored);
  }
  for (const item of stored.warmPool) {
    if (warmPool.length >= WARM_POOL_SIZE) break;
    if (!/^canvas-browser-warm-[a-z0-9-]+$/.test(item?.name || "") || !validDisplay(item?.display) || !await running(item.name)) continue;
    if (!await currentImage(item.name)) {
      await run("docker", ["rm", "-f", item.name], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
      console.log(JSON.stringify({ event: "browser_stale_warm_removed", count: 1 }));
      continue;
    }
    warmPool.push(item);
  }
  console.log(JSON.stringify({ event: "browser_registry_restored", sessions: sessions.size, warm: warmPool.length }));
  await persistRegistry();
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64_000) throw new Error("Body too large"); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return { raw, value: raw ? JSON.parse(raw) : {} };
}

function authenticate(req, path, raw) {
  const timestamp = req.headers["x-orchestrator-timestamp"] || "";
  const nonce = req.headers["x-orchestrator-nonce"] || "";
  const signature = req.headers["x-orchestrator-signature"] || "";
  const now = Date.now();
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !/^[A-Za-z0-9_-]{16,}$/.test(nonce)) return false;
  if (nonces.has(nonce)) return false;
  const expected = createHmac("sha256", SECRET).update(`${req.method}\n${path}\n${timestamp}\n${nonce}\n${raw}`).digest("base64url");
  if (!equal(signature, expected)) return false;
  nonces.set(nonce, now + 60_000);
  return true;
}

function authenticateRelay(req, requestPath, raw) {
  const timestamp = String(req.headers["x-relay-timestamp"] || ""), nonce = String(req.headers["x-relay-nonce"] || ""), signature = String(req.headers["x-relay-signature"] || "");
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000 || nonces.has(nonce)) return false;
  const expected = createHmac("sha256", RELAY_SECRET).update(`${req.method}\n${requestPath}\n${timestamp}\n${nonce}\n${raw}`).digest("base64url");
  if (!equal(signature, expected)) return false;
  nonces.set(nonce, Date.now() + 60_000); return true;
}

// Mirrors isValidCanvasLoginPath in lib/canvas/institution.ts (TS cannot be imported here); keep in sync.
const CANVAS_LOGIN_PATH = /^\/login(?:\/(?:saml|cas|openid_connect|microsoft|google|apple|linkedin|github|facebook|clever|ldap|canvas|instructure)(?:\/\d{1,12})?)?$/;
function validLoginPath(value) {
  return typeof value === "string" && value.length <= 64 && CANVAS_LOGIN_PATH.test(value);
}

function validOrigin(value) {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && validPublicHostname(url.hostname); } catch { return false; }
}

function validPublicHostname(value) {
  const host = String(value || "").toLowerCase().replace(/\.$/, "");
  return host.length <= 253 && host.includes(".") && !host.includes(":") && !/^\d+(?:\.\d+){3}$/.test(host) &&
    !["localhost", "localhost.localdomain", "0.0.0.0"].includes(host) &&
    ![".local", ".localhost", ".internal", ".home", ".lan"].some((suffix) => host.endsWith(suffix)) &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

// Per-institution rules are EXACT hostnames (max 8). Wildcards such as
// "*.duosecurity.com" fail validPublicHostname and are rejected; third-party
// IdP tenants are covered by the built-in list in navigation-policy.mjs, which
// does not count toward the eight.
function validAuthHostRules(value) {
  if (!Array.isArray(value) || value.length > 8) return null;
  const rules = value.map((item) => String(item).toLowerCase().replace(/\.$/, ""));
  return rules.every(validPublicHostname) ? [...new Set(rules)] : null;
}

function publicAddress(value) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return publicAddress(mapped[1]);
  const family = isIP(value);
  if (family === 4) {
    const octets = value.split(".").map(Number); const n = octets.reduce((x, octet) => ((x << 8) + octet) >>> 0, 0);
    const inRange = (base, bits) => { const b = base.split(".").map(Number).reduce((x, octet) => ((x << 8) + octet) >>> 0, 0); const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0; return (n & mask) === (b & mask); };
    return ![["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]].some(([base,bits]) => inRange(base,bits));
  }
  if (family === 6) { const v = value.toLowerCase(); return v !== "::" && v !== "::1" && !v.startsWith("fc") && !v.startsWith("fd") && !/^fe[89ab]/.test(v) && !v.startsWith("ff") && !v.startsWith("2001:db8:"); }
  return false;
}

async function resolvesPublicOnly(hostname) {
  try { const addresses = await lookup(hostname, { all: true, verbatim: true }); return addresses.length > 0 && addresses.every(({ address }) => publicAddress(address)); }
  catch { return false; }
}

// validDisplay / mobileLaunchEnv live in ./display-policy.mjs so they can be tested directly.

// allowedInteractiveUrl (exact Canvas origin, exact institution rules, or a
// built-in trusted identity provider) lives in ./navigation-policy.mjs so it
// can be tested directly and kept identical to the relay/app policy.

async function openInteractivePage(session, target) {
  if (!allowedInteractiveUrl(target, session.canvasOrigin, session.authHostRules)) throw new Error("Interactive navigation is not allowed");
  try {
    await relayRequest("POST", `/v1/sessions/${session.id}/navigate`, { url: target });
  } catch (error) {
    console.warn(JSON.stringify({ event: "browser_navigation_failed", status: Number(error?.status) || 0, code: typeof error?.code === "string" ? error.code : "UPSTREAM_ERROR" }));
    throw error;
  }
}

async function launchBrowser(name, labels, display) {
  const startedAt = Date.now();
  const args = ["run", "-d", "--rm", "--name", name,
    "--label", "canvas.browser.managed=true", ...labels.flatMap((label) => ["--label", label]),
    "--network", NETWORK, "--cpus", "1", "--memory", "1024m", "--memory-swap", "1024m", "--pids-limit", "256",
    "--shm-size", "256m",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001",
    "--tmpfs", "/run/browser:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001",
    "--tmpfs", "/profile:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700",
    // The browser reaches the proxy only over its per-session network, where
    // Docker DNS resolves the proxy by container name. The compose service
    // alias (browser-egress-proxy) exists only on the uplink network.
    "-e", `BROWSER_EGRESS_PROXY=http://${EGRESS_PROXY_CONTAINER}:3128`,
    ...mobileLaunchEnv(display),
    IMAGE, String(display.width), String(display.height)];
  try {
    await run("docker", args, { timeout: 30_000, windowsHide: true });
  } catch (error) {
    await run("docker", ["rm", "-f", name], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({ event: "browser_ready", profile: display?.mobile ? "mobile" : "desktop", durationMs: Date.now() - startedAt }));
}

async function replenishWarmPool() {
  if (replenishing || WARM_POOL_SIZE === 0) return;
  replenishing = true;
  try {
    while (warmPool.length < WARM_POOL_SIZE) {
      const name = `canvas-browser-warm-${randomUUID()}`;
      await launchBrowser(name, ["canvas.browser.warm=true"], DEFAULT_DISPLAY);
      warmPool.push({ name, readyAt: Date.now(), display: DEFAULT_DISPLAY });
      await persistRegistry();
    }
  } catch { /* A cold launch remains available; retry on the next claim/interval. */ }
  finally { replenishing = false; }
}

async function createBrowser(canvasOrigin, authHostRules, loginPath, display) {
  const startedAt = Date.now();
  const id = randomUUID();
  // Warm browsers are desktop-profile only; mobile sessions always cold-launch.
  const warmIndex = display.mobile ? -1 : warmPool.findIndex((item) => !item.display.mobile && item.display.width === display.width && item.display.height === display.height);
  const warm = warmIndex >= 0 ? warmPool.splice(warmIndex, 1)[0] : undefined;
  let name = warm?.name ?? `canvas-browser-${id}`;
  if (!warm) await launchBrowser(name, [`canvas.browser.session=${id}`], display);
  else {
    const claimedName = `canvas-browser-${id}`;
    await run("docker", ["rename", name, claimedName], { timeout: 10_000, windowsHide: true });
    name = claimedName;
  }
  const session = { id, name, canvasOrigin, authHostRules, loginPath, display, createdAt: Date.now(), lastUsedAt: Date.now() };
  sessions.set(id, session);
  let createStage = "network";
  try {
    await ensureSessionNetwork(session);
    createStage = "relay-register";
    await registerRelaySession(session);
    createStage = "browser-ready";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { await relayRequest("GET", `/v1/sessions/${session.id}/ready`); break; }
      catch (error) { if (attempt === 59) throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "browser_create_failed", stage: createStage, code: typeof error?.code === "string" ? error.code : "INTERNAL" }));
    sessions.delete(id);
    await relayRequest("DELETE", `/v1/sessions/${id}`).catch(() => undefined);
    await run("docker", ["rm", "-f", name], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
    await removeSessionNetwork(id);
    throw error;
  }
  await persistRegistry();
  console.log(JSON.stringify({ event: "browser_claimed", durationMs: Date.now() - startedAt, warm: Boolean(warm), profile: display.mobile ? "mobile" : "desktop" }));
  void replenishWarmPool();
  return session;
}

async function removeBrowser(session) {
  if (removals.has(session.id)) return;
  removals.add(session.id);
  await revokeSessionLive(session.id);
  sessions.delete(session.id);
  for (const [key, item] of liveTokens) if (item.sessionId === session.id) liveTokens.delete(key);
  for (const [key, item] of viewerGrants) if (item.sessionId === session.id) viewerGrants.delete(key);
  for (const [key, item] of connectTokens) if (item.sessionId === session.id) connectTokens.delete(key);
  try {
    await run("docker", ["rm", "-f", session.name], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
    await relayRequest("DELETE", `/v1/sessions/${session.id}`).catch(() => undefined);
    await removeSessionNetwork(session.id);
    await persistRegistry();
    void replenishWarmPool();
  } finally { removals.delete(session.id); }
}

async function browserIsRunning(session) {
  const inspected = await run("docker", ["inspect", "-f", "{{.State.Running}}", session.name], {
    timeout: 10_000, windowsHide: true,
  }).catch(() => ({ stdout: "false" }));
  return inspected.stdout.trim() === "true";
}


async function forgetMissingBrowser(session) {
  await revokeSessionLive(session.id);
  await relayRequest("DELETE", `/v1/sessions/${session.id}`).catch(() => undefined);
  await removeSessionNetwork(session.id);
  sessions.delete(session.id);
  for (const [key, item] of liveTokens) if (item.sessionId === session.id) liveTokens.delete(key);
  for (const [key, item] of viewerGrants) if (item.sessionId === session.id) viewerGrants.delete(key);
  for (const [key, item] of connectTokens) if (item.sessionId === session.id) connectTokens.delete(key);
  await persistRegistry();
  void replenishWarmPool();
}

async function reconcileOrphans(ownedSessionIds) {
  const registryNames = new Set([
    ...[...sessions.values()].map((item) => item.name),
    ...warmPool.map((item) => item.name),
  ]);
  const ownedNames = new Set(ownedSessionIds.map((id) => `canvas-browser-${id}`));
  const listed = await run("docker", ["ps", "-a", "--filter", "label=canvas.browser.managed=true", "--format", "{{.Names}}"], { timeout: 10_000, windowsHide: true });
  let removed = 0; let quarantined = 0;
  for (const name of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    if (registryNames.has(name) || ownedNames.has(name)) continue;
    const inspected = await run("docker", ["inspect", "-f", "{{.Created}}", name], { timeout: 10_000, windowsHide: true }).catch(() => ({ stdout: "" }));
    const action = classifyManagedContainer({ name, createdAt: inspected.stdout.trim(), registryNames, ownedSessionIds, graceMs: ORPHAN_GRACE_MS });
    if (action !== "remove") { quarantined += 1; continue; }
    await run("docker", ["rm", "-f", name], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
    removed += 1;
  }
  console.log(JSON.stringify({ event: "browser_orphan_reconcile", removed, quarantined, protected: registryNames.size + ownedNames.size }));
  return { removed, quarantined, protected: registryNames.size + ownedNames.size };
}

function viewerCookie(req) {
  const match = /(?:^|;\s*)browser_view=([^;]+)/.exec(req.headers.cookie || "");
  return match?.[1];
}

async function revokeSessionLive(sessionId) {
  for (const [key, item] of liveTokens) if (item.sessionId === sessionId) liveTokens.delete(key);
  for (const [key, item] of viewerGrants) if (item.sessionId === sessionId) viewerGrants.delete(key);
  for (const socket of viewerSockets.get(sessionId) || []) socket.destroy();
  viewerSockets.delete(sessionId);
  await relayRequest("POST", `/v1/sessions/${sessionId}/revoke`, {}).catch(() => undefined);
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"],
  [".ico", "image/x-icon"], [".woff", "font/woff"], [".woff2", "font/woff2"],
]);

// The chrome-free viewer shell (viewer/viewer.html + viewer.js) replaces noVNC's
// stock vnc.html UI. It emits the canvas-grove-viewer postMessage contract
// (shell-ready, ws-ready, disconnected, failed) itself; noVNC's own UI pages are
// never served, only its core/ and vendor/ modules.
const VIEWER_PAGE = "viewer.html";
const VIEWER_FILES = new Set([VIEWER_PAGE, "viewer.js", "viewer.css", "viewer-input.js"]);
const NOVNC_UI_PAGES = new Set(["vnc.html", "vnc_lite.html", "vnc_auto.html", "index.html", "app/ui.js"]);
const viewerCsp = (host) => {
  const sameHost = typeof host === "string" && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) ? ` wss://${host} ws://${host}` : "";
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${sameHost}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
};

function viewerFailure(res, status, message, type = "authorization-expired") {
  const safe = JSON.stringify(message);
  const body = `<!doctype html><html><body style="margin:0;background:#111827;color:white;font:16px system-ui;display:grid;min-height:100vh;place-content:center;text-align:center;padding:24px"><strong>${message}</strong><script>window.parent.postMessage({source:'canvas-grove-viewer',type:'${type}',detail:${safe}},window.location.origin)</script></body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

async function readViewerAsset(upstreamPath) {
  const pathname = decodeURIComponent(upstreamPath.split("?", 1)[0]);
  const normalized = path.normalize(pathname).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("..") || normalized.includes("\\") || normalized === "websockify") return null;
  if (NOVNC_UI_PAGES.has(normalized)) return null;
  const own = VIEWER_FILES.has(normalized);
  let pending = viewerAssets.get(normalized);
  if (!pending) {
    pending = readFile(`${own ? VIEWER_ROOT : NOVNC_ROOT}/${normalized}`).catch((error) => {
      viewerAssets.delete(normalized);
      if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
      throw error;
    });
    viewerAssets.set(normalized, pending);
  }
  const body = await pending;
  return body && { body, extension: path.extname(normalized), name: normalized, own };
}

// Cookie-authenticated Server-Sent Events for the viewer. Emits exactly one
// event type, "landed", as soon as the remote browser reaches Canvas outside
// /login. The relay answers with a boolean only; no URL or cookie ever leaves it.
const LANDED_POLL_MS = 250, VIEWER_EVENT_STREAMS_PER_SESSION = 2;
function serveViewerEvents(req, res, session, grantKey) {
  const streams = session.viewerEventStreams || 0;
  if (streams >= VIEWER_EVENT_STREAMS_PER_SESSION) { res.writeHead(429, { "cache-control": "no-store" }); return res.end(); }
  session.viewerEventStreams = streams + 1;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
  res.write("retry: 1000\n\n");
  const active = viewerSockets.get(session.id) || new Set(); active.add(res); viewerSockets.set(session.id, active);
  let closed = false, timer;
  const heartbeat = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15_000);
  const stop = () => {
    if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat);
    session.viewerEventStreams = Math.max(0, (session.viewerEventStreams || 1) - 1);
    active.delete(res); if (active.size === 0 && viewerSockets.get(session.id) === active) viewerSockets.delete(session.id);
    if (!res.writableEnded) res.end();
  };
  req.once("close", stop); res.once("close", stop);
  const tick = async () => {
    if (closed) return;
    const grant = viewerGrants.get(grantKey);
    if (!grant || grant.expiresAt < Date.now() || sessions.get(session.id) !== session) return stop();
    try {
      const result = await relayRequest("GET", `/v1/sessions/${session.id}/landed`);
      if (closed) return;
      if (result?.landed === true) { res.write("event: landed\ndata: {}\n\n"); return stop(); }
    } catch { /* transient relay failure: keep polling until the grant expires */ }
    timer = setTimeout(tick, LANDED_POLL_MS);
  };
  void tick();
}

async function serveViewer(req, res, session, upstreamPath) {
  session.lastUsedAt = Date.now();
  const asset = await readViewerAsset(upstreamPath);
  if (!asset) return viewerFailure(res, 404, "Secure viewer asset not found.", "failed");
  const body = asset.body;
  const headers = { "content-type": mimeTypes.get(asset.extension) || "application/octet-stream",
    "content-length": body.length, "x-content-type-options": "nosniff",
    // Our own shell must never be served stale after a deploy; noVNC modules are immutable per image.
    "cache-control": asset.name === VIEWER_PAGE ? "no-store" : asset.own ? "private, no-cache" : "private, max-age=3600" };
  if (asset.name === VIEWER_PAGE) Object.assign(headers, { "content-security-policy": viewerCsp(req.headers.host), "referrer-policy": "no-referrer" });
  res.writeHead(200, headers);
  res.end(body);
}

function proxyCdp(req, res, session, relayToken, upstreamPath, publicPrefix) {
  session.lastUsedAt = Date.now();
  const upstream = httpRequest({ hostname: relayOrigin.hostname, port: Number(relayOrigin.port) || 80, method: req.method,
    path: `/proxy/cdp/${relayToken}${upstreamPath || "/"}`, headers: { ...req.headers, host: relayOrigin.host } }, (incoming) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      let body = Buffer.concat(chunks);
      if ((incoming.headers["content-type"] || "").includes("application/json")) {
        body = Buffer.from(body.toString("utf8").replace(/ws:\/\/[^/]+/g, publicPrefix));
      }
      res.writeHead(incoming.statusCode || 502, { ...incoming.headers, "content-length": body.length,
        "cache-control": "no-store" }); res.end(body);
    });
  });
  upstream.on("error", () => send(res, 502, { error: "Browser automation unavailable" })); req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://orchestrator");
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, activeSessions: sessions.size });
    const cdp = /^\/cdp\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (req.method === "GET" && cdp) {
      const entry = connectTokens.get(hash(cdp[1])); const session = entry && sessions.get(entry.sessionId);
      if (!entry || entry.expiresAt < Date.now() || !session) return send(res, 401, { error: "Automation authorization expired" });
      return proxyCdp(req, res, session, entry.relayToken, cdp[2] || "/", `ws://${req.headers.host}/cdp/${cdp[1]}`);
    }
    const redeem = /^\/live\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method === "GET" && redeem) {
      const entry = liveTokens.get(hash(redeem[1]));
      liveTokens.delete(hash(redeem[1]));
      if (!entry || entry.expiresAt < Date.now() || !sessions.has(entry.sessionId)) return send(res, 410, { error: "Live-view link expired or already used" });
      const grant = randomBytes(32).toString("base64url");
      viewerGrants.set(hash(grant), { sessionId: entry.sessionId, relayToken: entry.relayToken, expiresAt: entry.expiresAt });
      res.writeHead(302, { location: `/viewer/${entry.sessionId}/${VIEWER_PAGE}`, "set-cookie": `browser_view=${grant}; HttpOnly; Secure; SameSite=Strict; Path=/viewer/${entry.sessionId}; Max-Age=300`, "cache-control": "no-store" }); return res.end();
    }
    const viewer = /^\/viewer\/([0-9a-f-]+)(\/.*)$/.exec(url.pathname);
    if (viewer && req.method === "GET") {
      const grant = viewerGrants.get(hash(viewerCookie(req) || "")); const session = sessions.get(viewer[1]);
      if (!grant || grant.sessionId !== viewer[1] || grant.expiresAt < Date.now() || !session) return viewerFailure(res, 401, "Secure viewer authorization expired.");
      if (viewer[2] === "/events") return serveViewerEvents(req, res, session, hash(viewerCookie(req) || ""));
      return serveViewer(req, res, session, viewer[2]);
    }
    const { raw, value } = await readBody(req);
    if (req.method === "POST" && url.pathname === "/v1/internal/navigation-blocked") {
      if (!authenticateRelay(req, url.pathname, raw)) return send(res, 401, { error: "Unauthorized" });
      const session = typeof value.sessionId === "string" && sessions.get(value.sessionId);
      const blockedHost = typeof value.blockedHost === "string" && validPublicHostname(value.blockedHost) ? value.blockedHost.toLowerCase() : undefined;
      if (!session) return send(res, 404, { error: "Session not found" });
      navigationTombstones.set(session.id, { ...(blockedHost ? { blockedHost } : {}), expiresAt: Date.now() + 5 * 60_000 });
      console.warn(JSON.stringify({ event: "browser_navigation_guard_blocked", sessionId: session.id, ...(blockedHost ? { blockedHost } : {}) }));
      await removeBrowser(session);
      return send(res, 200, { removed: true });
    }
    if (!authenticate(req, url.pathname, raw)) return send(res, 401, { error: "Unauthorized" });
    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      if (!validOrigin(value.canvasOrigin)) return send(res, 400, { error: "canvasOrigin must be a public HTTPS origin" });
      const authHostRules = validAuthHostRules(value.authHostRules ?? []);
      if (!authHostRules) return send(res, 400, { error: "authHostRules must contain public hostnames", code: "NAVIGATION_BLOCKED" });
      if (!await resolvesPublicOnly(new URL(value.canvasOrigin).hostname) || !(await Promise.all(authHostRules.map(resolvesPublicOnly))).every(Boolean)) {
        return send(res, 400, { error: "Institution hosts must resolve only to public addresses", code: "NAVIGATION_BLOCKED" });
      }
      if (value.loginPath !== undefined && value.loginPath !== null && !validLoginPath(value.loginPath)) {
        return send(res, 400, { error: "loginPath must be a Canvas sign-in path", code: "INVALID_LOGIN_PATH" });
      }
      const loginPath = validLoginPath(value.loginPath) ? value.loginPath : "/login";
      const display = validDisplay(value.display ?? DEFAULT_DISPLAY);
      if (!display) return send(res, 400, { error: "display dimensions are invalid", code: "INVALID_DISPLAY" });
      if (sessions.size >= MAX_SESSIONS) return send(res, 429, { error: "Browser host is at capacity", code: "CAPACITY" });
      const session = await createBrowser(value.canvasOrigin, authHostRules, loginPath, display); return send(res, 201, { id: session.id, state: "starting", display });
    }
    if (req.method === "POST" && url.pathname === "/v1/reconcile") {
      if (!Array.isArray(value.ownedSessionIds) || value.ownedSessionIds.length > 10_000 ||
          value.ownedSessionIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) {
        return send(res, 400, { error: "ownedSessionIds are invalid" });
      }
      const verifiedOrphanNames = value.verifiedOrphanNames ?? [];
      if (!Array.isArray(verifiedOrphanNames) || verifiedOrphanNames.length > 1_000 ||
          verifiedOrphanNames.some((name) => typeof name !== "string" || !/^canvas-browser-(?:warm-)?[0-9a-f-]{36}$/.test(name))) {
        return send(res, 400, { error: "verifiedOrphanNames are invalid" });
      }
      lastOwnedSessionIds = [...new Set(value.ownedSessionIds)];
      return send(res, 200, await reconcileOrphans(lastOwnedSessionIds));
    }
    const match = /^\/v1\/sessions\/([0-9a-f-]+)(?:\/(connect|live|revoke-live|navigate))?$/.exec(url.pathname);
    const session = match && sessions.get(match[1]);
    if (!session) {
      const tombstone = match && navigationTombstones.get(match[1]);
      if (tombstone?.expiresAt > Date.now()) return send(res, 400, { error: "The sign-in redirect was blocked for safety.", code: "NAVIGATION_BLOCKED", ...(tombstone.blockedHost ? { blockedHost: tombstone.blockedHost } : {}) });
      return send(res, 404, { error: "Session not found" });
    }
    session.lastUsedAt = Date.now();
    if (req.method === "GET" && !match[2]) {
      return send(res, 200, { state: await browserIsRunning(session) ? "running" : "failed" });
    }
    // A durable registry entry can outlive its container after a host restart,
    // OOM, or manual cleanup. Report that as a missing session so the app's
    // guarded single-flight path provisions one replacement instead of
    // surfacing a misleading generic host failure.
    if (req.method !== "DELETE" && !await browserIsRunning(session)) {
      await forgetMissingBrowser(session);
      return send(res, 404, { error: "Session not found" });
    }
    if (req.method === "GET" && match[2] === "connect") {
      const relayCapability = await relayRequest("POST", `/v1/sessions/${session.id}/capability`, { kind: "cdp", ttlSeconds: 60 });
      const token = randomBytes(32).toString("base64url");
      connectTokens.set(hash(token), { sessionId: session.id, relayToken: relayCapability.token, expiresAt: Date.now() + 60_000 });
      return send(res, 200, { cdpUrl: `http://${req.headers.host}/cdp/${token}` });
    }
    if (req.method === "POST" && match[2] === "live") {
      const startedAt = Date.now();
      await revokeSessionLive(session.id);
      const relayCapability = await relayRequest("POST", `/v1/sessions/${session.id}/capability`, { kind: "viewer", ttlSeconds: 300 });
      const token = randomBytes(32).toString("base64url"); const expiresAt = Date.now() + 5 * 60_000;
      liveTokens.set(hash(token), { sessionId: session.id, relayToken: relayCapability.token, expiresAt });
      console.log(JSON.stringify({ event: "live_url_issued", durationMs: Date.now() - startedAt }));
      return send(res, 201, { url: `/live/${token}`, expiresAt });
    }
    if (req.method === "POST" && match[2] === "navigate") {
      await openInteractivePage(session, value.url);
      return send(res, 200, { navigated: true });
    }
    if (req.method === "POST" && match[2] === "revoke-live") {
      await revokeSessionLive(session.id);
      return send(res, 200, { revoked: true });
    }
    if (req.method === "DELETE" && !match[2]) { await removeBrowser(session); return send(res, 200, { terminated: true }); }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof Error && error.message === "Interactive navigation is not allowed") {
      return send(res, 400, { error: "Interactive navigation is not allowed", code: "NAVIGATION_BLOCKED" });
    }
    return send(res, 500, { error: "Browser host could not complete the request", code: "BROWSER_HOST_ERROR" });
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://orchestrator");
  const cdp = /^\/cdp\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
  if (cdp) {
    const entry = connectTokens.get(hash(cdp[1])); const session = entry && sessions.get(entry.sessionId);
    if (!entry || entry.expiresAt < Date.now() || !session) return socket.destroy();
    const upstream = httpRequest({ hostname: relayOrigin.hostname, port: Number(relayOrigin.port) || 80,
      path: `/proxy/cdp/${entry.relayToken}${cdp[2]}`, headers: { ...req.headers, host: relayOrigin.host } });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head); if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("error", () => socket.destroy()); upstream.end(); return;
  }
  const viewer = /^\/viewer\/([0-9a-f-]+)\/websockify$/.exec(url.pathname);
  const grantKey = hash(viewerCookie(req) || ""); const grant = viewerGrants.get(grantKey); const session = viewer && sessions.get(viewer[1]);
  if (!viewer || !grant || grant.sessionId !== viewer[1] || grant.expiresAt < Date.now() || !session) return socket.destroy();
  const forwardedHeaders = { ...req.headers };
  delete forwardedHeaders.cookie;
  let settled = false;
  const active = viewerSockets.get(session.id) || new Set(); active.add(socket); viewerSockets.set(session.id, active);
  const removeActive = (item) => { active.delete(item); if (active.size === 0) viewerSockets.delete(session.id); };
  socket.once("close", () => removeActive(socket));
  const attempt = (number = 0) => {
    const currentGrant = viewerGrants.get(grantKey);
    if (socket.destroyed || currentGrant !== grant || currentGrant?.expiresAt < Date.now() || sessions.get(session.id) !== session) return socket.destroy();
    const upstream = httpRequest({ hostname: relayOrigin.hostname, port: Number(relayOrigin.port) || 80,
      path: `/proxy/viewer/${grant.relayToken}/websockify`, headers: { ...forwardedHeaders, host: relayOrigin.host } });
    active.add(upstream); upstream.once("close", () => removeActive(upstream));
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      const current = viewerGrants.get(grantKey);
      if (current !== grant || current?.expiresAt < Date.now() || sessions.get(session.id) !== session) { upstreamSocket.destroy(); socket.destroy(); return; }
      settled = true;
      active.add(upstreamSocket); upstreamSocket.once("close", () => removeActive(upstreamSocket));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head); if (upstreamHead.length) socket.write(upstreamHead); upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("response", (response) => { response.resume(); if (!settled) retry(); });
    upstream.on("error", () => { if (!settled) retry(); });
    const retry = () => {
      if (number >= 9 || socket.destroyed) return socket.destroy();
      setTimeout(() => attempt(number + 1), Math.min(50 * 2 ** number, 1000));
    };
    upstream.end();
  };
  attempt();
});

setInterval(() => {
  const now = Date.now();
  for (const [nonce, expires] of nonces) if (expires < now) nonces.delete(nonce);
  for (const [key, item] of liveTokens) if (item.expiresAt < now) liveTokens.delete(key);
  for (const [key, item] of viewerGrants) if (item.expiresAt < now) viewerGrants.delete(key);
  for (const [key, item] of connectTokens) if (item.expiresAt < now) connectTokens.delete(key);
  for (const [id, item] of navigationTombstones) if (item.expiresAt < now) navigationTombstones.delete(id);
  for (const session of sessions.values()) if (now - session.lastUsedAt > IDLE_TTL_MS) removeBrowser(session);
  void replenishWarmPool();
  if (lastOwnedSessionIds) void reconcileOrphans(lastOwnedSessionIds).catch(() => undefined);
  void reconcileSessionNetworks().catch(() => undefined);
}, 30_000).unref();

setInterval(() => { void reconcileRelayEpoch(); }, 5_000).unref();

async function start() {
  await restoreRegistry();
  await persistRegistry();
  server.listen(PORT, "0.0.0.0");
  void reconcileRelayEpoch();
  void replenishWarmPool();
}
void start().catch(() => process.exit(1));
