// DEV-ONLY: record how Canvas's own quiz player drives a quiz (e.g. one-question-at-a-time),
// so Grove can reproduce the same calls. Starts a hosted Chromium via the orchestrator,
// loads an existing hosted session's Canvas cookies into it (no Duo), opens the quiz,
// and records clicks + Canvas requests while the user drives it over noVNC.
//
//   docker exec canvas-grove-sync-worker-1 npx tsx scripts/quiz-flow-recorder.ts <session-id-prefix> <quiz-html-url> [owner-id-prefix]
//
// Control files (inside the container):  touch /tmp/quiz-recordings/STOP  -> finish + tear down
//                                         touch /tmp/quiz-recordings/LIVE  -> print a fresh noVNC link
// Output: /tmp/quiz-recordings/<stamp>/{events.jsonl,pages/*.html}. Tokens/CSRF values and
// non-numeric form values are masked; cookie values are never written.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import process from "node:process";
import postgres from "postgres";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright-core";
import { CanvasSessionClient, SESSION_COOKIE_NAMES, type StoredBrowserState, type StoredCookie } from "../lib/canvas/session-client";
import { sqlEncryptedStateStore } from "../lib/canvas/session-store-sql";
import { envelopeDecryptBrowserState, envelopeEncryptBrowserState } from "../lib/bridge/providers/envelope";
import { assertDevOwner, devOwnerId } from "../lib/dev/dev-owner";

const ROOT = "/tmp/quiz-recordings";
const MAX_MS = 45 * 60_000;
const PUBLIC_BASE = (process.env.BROWSER_PUBLIC_BASE_URL || "https://canvas-grove.tail8dc4e4.ts.net").replace(/\/$/, "");
const ORCH = process.env.BROWSER_ORCHESTRATOR_URL?.replace(/\/$/, "");
const SECRET = process.env.BROWSER_ORCHESTRATOR_SECRET;
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

const prefix = (process.argv[2] ?? "").toLowerCase();
const quizUrl = process.argv[3] ?? "";
// Safety: the DB holds several Grove users. Only the developer's own account (DEV_OWNER_ID / .dev-owner) is ever used;
// an optional 3rd arg (owner id prefix) must also match it.
const expectedOwner = (process.argv[4] ?? "").toLowerCase();
if (expectedOwner && !devOwnerId().startsWith(expectedOwner)) throw new Error("Owner argument does not match DEV_OWNER_ID (.dev-owner)");
if (!/^[0-9a-f-]{6,36}$/.test(prefix)) throw new Error("Pass a hosted session id prefix");
if (!/^https:\/\/[^/]+\/courses\/\d+\/quizzes\/\d+/.test(quizUrl)) throw new Error("Pass the quiz html_url");
if (!ORCH || !SECRET) throw new Error("Orchestrator env unavailable");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `${ROOT}/${stamp}`;
mkdirSync(`${outDir}/pages`, { recursive: true });
for (const f of ["STOP", "LIVE"]) rmSync(`${ROOT}/${f}`, { force: true });
const t0 = Date.now();
let seq = 0;
function emit(kind: string, data: Record<string, unknown>) {
  appendFileSync(`${outDir}/events.jsonl`, JSON.stringify({ n: ++seq, ms: Date.now() - t0, kind, ...data }) + "\n");
}
const say = (msg: string) => console.log(`[recorder] ${msg}`);

// ------------------------------------------------------------------ orchestrator
async function orch<T>(method: string, path: string, value?: unknown): Promise<T> {
  const body = value === undefined ? "" : JSON.stringify(value);
  const timestamp = String(Date.now()), nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", SECRET!).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`).digest("base64url");
  const r = await fetch(`${ORCH}${path}`, { method, body: body || undefined, signal: AbortSignal.timeout(60_000), headers: {
    "content-type": "application/json", "x-orchestrator-timestamp": timestamp, "x-orchestrator-nonce": nonce, "x-orchestrator-signature": signature } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`orchestrator ${method} ${path.replace(/[0-9a-f-]{36}/, "<id>")} -> ${r.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json as T;
}
async function liveLink(id: string) {
  const { url } = await orch<{ url: string }>("POST", `/v1/sessions/${id}/live`, {});
  say(`noVNC link (valid to open for ~5 min): ${PUBLIC_BASE}${url}`);
}

// ------------------------------------------------------------------ redaction
const SECRET_KEY = /token|authenticity|password|passwd|access_code|csrf|secret|session/i;
function maskValue(key: string, value: string): string {
  if (SECRET_KEY.test(key)) return "<redacted>";
  if (/^-?\d{1,15}$/.test(value) || value === "" || /^(true|false|put|post|delete|patch)$/i.test(value)) return value;
  return `<text len ${value.length}>`;
}
function maskUrl(raw: string): string {
  const u = new URL(raw);
  for (const [k, v] of [...u.searchParams]) u.searchParams.set(k, maskValue(k, v));
  return u.pathname + (u.search ? decodeURIComponent(u.search) : "");
}
function formFields(contentType: string, body: string | null): unknown {
  if (!body) return undefined;
  if (contentType.includes("application/x-www-form-urlencoded")) return [...new URLSearchParams(body)].map(([k, v]) => [k, maskValue(k, v)]);
  if (contentType.includes("multipart/form-data")) return [...body.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  if (contentType.includes("json")) { try { return shape(JSON.parse(body), 3); } catch { return `<json len ${body.length}>`; } }
  return `<${contentType || "body"} len ${body.length}>`;
}
function shape(v: unknown, depth: number, key = ""): unknown {
  if (Array.isArray(v)) return v.length ? [`len ${v.length}`, shape(v[0], depth - 1, key)] : [];
  if (v && typeof v === "object") {
    if (depth <= 0) return `{${Object.keys(v).join(",")}}`;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x, depth - 1, k)]));
  }
  if (typeof v === "string") return maskValue(key, v);
  return v;
}
function sanitizeHtml(html: string): string {
  return html
    .replace(/(name=["'](?:authenticity_token|validation_token|_csrf[^"']*)["'][^>]*?value=["'])[^"']*/gi, "$1REDACTED")
    .replace(/(value=["'])[^"']*(["'][^>]*?name=["'](?:authenticity_token|validation_token)["'])/gi, "$1REDACTED$2")
    .replace(/(<meta[^>]+name=["']csrf-token["'][^>]+content=["'])[^"']*/gi, "$1REDACTED")
    .replace(/("(?:[a-z_]*token|csrf[a-z_]*|authenticity_token)"\s*:\s*")[^"]*/gi, "$1REDACTED");
}
function htmlSummary(html: string) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({
    id: /\bid=["']([^"']+)/i.exec(m[1])?.[1], action: /\baction=["']([^"']+)/i.exec(m[1])?.[1], method: /\bmethod=["']([^"']+)/i.exec(m[1])?.[1],
    inputs: [...new Set([...m[2].matchAll(/<(?:input|select|textarea)\b[^>]*\bname=["']([^"']+)/gi)].map((x) => x[1].replace(/\d{3,}/g, "<id>")))],
  }));
  const quizLinks = [...new Set([...html.matchAll(/["'](\/courses\/\d+\/quizzes\/\d+\/[^"'?#]*)/g)].map((m) => m[1]))];
  const envKeys = /ENV\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html)?.[1];
  let env: unknown;
  try { env = envKeys ? shape(JSON.parse(envKeys), 1) : undefined; } catch { env = "<unparsed>"; }
  return { forms, quizLinks, env, questionIds: [...new Set([...html.matchAll(/\bquestion_(\d+)\b/g)].map((m) => m[1]))].slice(0, 50) };
}

// ------------------------------------------------------------------ recording
let pageSeq = 0;
const isAsset = (u: URL) => /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)$/i.test(u.pathname) || u.pathname.startsWith("/dist/");
function wantRequest(req: Request, origin: string) {
  let u: URL; try { u = new URL(req.url()); } catch { return false; }
  if (u.origin !== origin) return false;
  if (req.method() !== "GET") return true;
  return !isAsset(u) && ["document", "xhr", "fetch", "other"].includes(req.resourceType());
}
async function onResponse(res: Response, origin: string) {
  const req = res.request();
  if (!wantRequest(req, origin)) return;
  const reqCt = (await req.allHeaders().catch(() => ({} as Record<string, string>)))["content-type"] ?? "";
  const resCt = res.headers()["content-type"] ?? "";
  const entry: Record<string, unknown> = { method: req.method(), url: maskUrl(req.url()), type: req.resourceType(), status: res.status(),
    reqContentType: reqCt || undefined, sent: formFields(reqCt, req.postData()), resContentType: resCt || undefined,
    redirectTo: res.headers()["location"] ? maskUrl(new URL(res.headers()["location"], req.url()).href) : undefined,
    xRequestedWith: (await req.allHeaders().catch(() => ({} as Record<string, string>)))["x-requested-with"] };
  if (res.status() < 300 || res.status() >= 400) {
    const body = await res.text().catch(() => null);
    if (body != null) {
      if (resCt.includes("json")) { try { entry.received = shape(JSON.parse(body.replace(/^while\(1\);/, "")), 3); } catch { entry.received = `<json len ${body.length}>`; } }
      else if (resCt.includes("html") && req.resourceType() === "document") {
        entry.html = htmlSummary(body);
        if (/\/quizzes\//.test(req.url())) { const file = `pages/${String(++pageSeq).padStart(3, "0")}.html`; writeFileSync(`${outDir}/${file}`, sanitizeHtml(body)); entry.savedAs = file; }
      } else entry.received = `<${resCt || "body"} len ${body.length}>`;
    }
  }
  emit("request", entry);
}
const CLICK_SCRIPT = `(() => { if (window.__qrec) return; window.__qrec = 1;
  const describe = (el) => { if (!el || !el.tagName) return null; const t = el.closest('a,button,input,label,select,textarea,[role=button],[onclick]') || el;
    return { tag: t.tagName.toLowerCase(), id: t.id || undefined, name: t.getAttribute('name') || undefined, type: t.getAttribute('type') || undefined,
      cls: (t.className && String(t.className).slice(0, 80)) || undefined, href: t.getAttribute('href') || undefined,
      text: (t.innerText || t.value || '').trim().replace(/\\s+/g, ' ').slice(0, 60) || undefined }; };
  const send = (kind, el, extra) => console.debug('__QREC__' + JSON.stringify({ kind, path: location.pathname, target: describe(el), ...extra }));
  addEventListener('click', (e) => send('click', e.target), true);
  addEventListener('change', (e) => send('change', e.target, { checked: e.target.checked }), true);
  addEventListener('submit', (e) => send('submit', e.target, { action: e.target.getAttribute('action'), method: e.target.getAttribute('method') }), true);
})();`;
function watchPage(page: Page) {
  page.on("console", (m) => { const t = m.text(); if (t.startsWith("__QREC__")) { try { emit("ui", JSON.parse(t.slice(8))); } catch { /* ignore */ } } });
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) { try { emit("navigate", { url: maskUrl(f.url()) }); } catch { /* about:blank */ } } });
  page.on("dialog", (d) => emit("dialog", { type: d.type(), message: d.message().slice(0, 200) }));
  void page.evaluate(CLICK_SCRIPT).catch(() => undefined);
}

// ------------------------------------------------------------------ main
async function tenant<T>(ownerId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${ownerId}, true)`; return work(tx); });
}
async function findSession() {
  for (const owner of [{ id: devOwnerId() }]) { // only ever the developer's own account
    const rows = await tenant(owner.id, (tx) => tx<{ id: string; canvas_origin: string }[]>`
      select s.id, p.canvas_origin from hosted_browser_sessions s join hosted_browser_profiles p on p.owner_id=s.owner_id and p.id=s.profile_id
      where s.owner_id=${owner.id} and s.revoked_at is null and s.id::text like ${`${prefix}%`}`);
    if (rows[0]) return { ownerId: owner.id, sessionId: rows[0].id, origin: rows[0].canvas_origin };
  }
  throw new Error("Hosted session not found");
}
function toPlaywright(c: StoredCookie) {
  return { name: c.name, value: c.value, domain: c.domain, path: c.path || "/", expires: c.expires > 0 ? c.expires : -1,
    httpOnly: Boolean(c.httpOnly), secure: Boolean(c.secure), sameSite: c.sameSite ?? "Lax" as const };
}

async function main() {
  const target = await findSession();
  assertDevOwner(target.ownerId, `recording session ${target.sessionId.slice(0, 8)}`);
  if (new URL(quizUrl).origin !== target.origin) throw new Error(`Quiz origin does not match session origin ${target.origin}`);
  const store = sqlEncryptedStateStore((w) => tenant(target.ownerId, w), target.ownerId, target.sessionId, { requireActive: false });
  const record = await store.load();
  if (!record) throw new Error("Session has no stored state");
  const jar = envelopeDecryptBrowserState(record.state, target.ownerId) as StoredBrowserState;
  const host = new URL(target.origin).hostname;
  const canvasCookies = (jar.cookies ?? []).filter((c) => host === c.domain.replace(/^\./, "") || host.endsWith(`.${c.domain.replace(/^\./, "")}`));
  say(`session ${target.sessionId.slice(0, 8)} on ${host}: ${canvasCookies.length} Canvas cookies (${canvasCookies.map((c) => c.name).join(", ")})`);
  emit("start", { session: target.sessionId.slice(0, 8), quiz: maskUrl(quizUrl), cookieNames: canvasCookies.map((c) => c.name) });

  const created = await orch<{ id: string }>("POST", "/v1/sessions", { canvasOrigin: target.origin, authHostRules: [], loginPath: "/login" });
  const browserId = created.id;
  say(`hosted browser ${browserId.slice(0, 8)} starting…`);
  for (let i = 0; i < 60; i += 1) {
    const s = await orch<{ state: string }>("GET", `/v1/sessions/${browserId}`).catch(() => ({ state: "pending" }));
    if (s.state === "running") break;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  let browser: Browser | null = null, context: BrowserContext | null = null, stopping = false, injected = false;
  const connect = async () => {
    const { cdpUrl } = await orch<{ cdpUrl: string }>("GET", `/v1/sessions/${browserId}/connect`);
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 90_000 });
    context = browser.contexts()[0];
    if (!injected) { await context.addCookies(canvasCookies.map(toPlaywright)); injected = true; }
    await context.addInitScript(CLICK_SCRIPT).catch(() => undefined);
    context.on("page", watchPage);
    context.on("response", (r) => { void onResponse(r, target.origin).catch((e) => emit("record_error", { msg: String(e?.message ?? e).slice(0, 120) })); });
    for (const p of context.pages()) watchPage(p);
    browser.on("disconnected", () => { if (!stopping) { emit("cdp_disconnected", {}); say("CDP disconnected; reconnecting…"); void connect().catch((e) => say(`reconnect failed: ${e.message}`)); } });
    emit("cdp_connected", {});
  };
  await connect();
  const page = context!.pages()[0] ?? await context!.newPage();
  await page.goto(quizUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  say(`opened ${new URL(page.url()).pathname} (title: ${(await page.title()).slice(0, 60)})`);
  await liveLink(browserId);
  say(`recording to ${outDir}. touch ${ROOT}/STOP to finish, ${ROOT}/LIVE for a new link.`);

  let lastPing = Date.now();
  while (Date.now() - t0 < MAX_MS && !existsSync(`${ROOT}/STOP`)) {
    if (existsSync(`${ROOT}/LIVE`)) { rmSync(`${ROOT}/LIVE`, { force: true }); await liveLink(browserId).catch((e) => say(e.message)); }
    if (Date.now() - lastPing > 4 * 60_000) { await orch("GET", `/v1/sessions/${browserId}`).catch(() => undefined); lastPing = Date.now(); }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  stopping = true;
  say("stopping…");

  // Is the stored (sync-worker) session still good? Only write the browser's cookies back if it is not.
  const browserCookies = await context!.cookies(target.origin).catch(() => []);
  const probe = new CanvasSessionClient({ ownerId: target.ownerId, canvasOrigin: target.origin, store });
  const check = await probe.request({ method: "GET", path: "/api/v1/users/self" });
  await probe.flush();
  emit("stored_session_check", { http: check.status, authRequired: check.authRequired });
  if (check.authRequired) {
    const fresh = await store.load();
    if (fresh) {
      const state = envelopeDecryptBrowserState(fresh.state, target.ownerId) as StoredBrowserState;
      const replacements = browserCookies.filter((c) => SESSION_COOKIE_NAMES.includes(c.name) || c.name === "pseudonym_credentials");
      const key = (c: { name: string; domain: string; path: string }) => `${c.name}|${c.domain}|${c.path}`;
      const byKey = new Map(state.cookies.map((c) => [key(c), c]));
      for (const c of replacements) byKey.set(key(c), { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite });
      const ok = await store.compareAndSwap(envelopeEncryptBrowserState({ ...state, cookies: [...byKey.values()] }, target.ownerId), fresh.version);
      say(`stored session needed re-auth; wrote back ${replacements.length} browser cookies: ${ok ? "ok" : "CAS conflict"}`);
      emit("writeback", { cookies: replacements.map((c) => c.name), ok });
    }
  } else say(`stored session still valid (HTTP ${check.status}); no write-back needed`);

  await (browser as Browser | null)?.close().catch(() => undefined);
  await orch("DELETE", `/v1/sessions/${browserId}`).catch((e) => say(`teardown: ${e.message}`));
  emit("end", {});
  say(`done. ${seq} events in ${outDir}`);
  await sql.end();
}
main().catch(async (e) => { console.error("[recorder] failed:", e instanceof Error ? e.message : "unknown"); emit("fatal", { msg: String(e?.message ?? e).slice(0, 200) }); await sql.end().catch(() => undefined); process.exit(1); });
