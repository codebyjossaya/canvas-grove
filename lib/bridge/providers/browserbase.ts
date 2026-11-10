import "server-only";
import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { digest } from "../crypto";
import type { EncryptedBrowserState, HostedBrowserProvider, HostedSessionState } from "../hosted-browser";
import { envelopeEncryptBrowserState } from "./envelope";
import { toCanvasLoginPath, type CanvasLoginPath } from "@/lib/canvas/institution";

type Handle = { sessionId: string; contextId: string; canvasOrigin: string; authHostRules: string[]; loginPath: CanvasLoginPath };

const encodeHandle = (value: Handle) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
function decodeHandle(value: string): Handle {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Handle>;
  if (!parsed.sessionId || !parsed.contextId || !parsed.canvasOrigin) throw new Error("Invalid Browserbase session handle");
  parsed.authHostRules = Array.isArray(parsed.authHostRules) ? parsed.authHostRules : [];
  parsed.loginPath = toCanvasLoginPath(parsed.loginPath);
  return parsed as Handle;
}

function config() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY is required");
  return { apiKey, projectId: process.env.BROWSERBASE_PROJECT_ID };
}

function allowedDomains(canvasOrigin: string, authHostRules: string[]): string[] {
  const canvasHost = new URL(canvasOrigin).hostname;
  const authHosts = authHostRules;
  for (const host of authHosts) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) throw new Error("BROWSERBASE_ALLOWED_AUTH_DOMAINS contains an invalid hostname");
  }
  return [...new Set([canvasHost, ...authHosts])];
}

async function withBrowser<T>(bb: Browserbase, handle: Handle, callback: (browser: Browser, page: Page) => Promise<T>): Promise<T> {
  const session = await bb.sessions.retrieve(handle.sessionId);
  if (!session.connectUrl) throw new Error("Browserbase session is no longer connectable");
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    return await callback(browser, page);
  } finally {
    await browser.close();
  }
}

export class BrowserbaseHostedBrowserProvider implements HostedBrowserProvider {
  private client() { return new Browserbase(config()); }

  private async startSession(bb: Browserbase, contextId: string, canvasOrigin: string, authHostRules: string[], ownerHash?: string) {
    return bb.sessions.create({
      projectId: config().projectId,
      keepAlive: true,
      api_timeout: Number(process.env.BROWSERBASE_SESSION_TIMEOUT_SECONDS || 21_600),
      userMetadata: { ...(ownerHash ? { ownerHash } : {}), purpose: "canvas-grove" },
      browserSettings: {
        context: { id: contextId, persist: true },
        allowedDomains: allowedDomains(canvasOrigin, authHostRules),
        ignoreCertificateErrors: false,
        recordSession: false,
        logSession: false,
        solveCaptchas: false,
      },
    });
  }

  async provision(input: { ownerId: string; canvasOrigin: string; authHostRules: string[]; loginPath: CanvasLoginPath; encryptedState?: EncryptedBrowserState }) {
    if (input.encryptedState) throw new Error("Browserbase restores persisted state through its encrypted Context; blob import is intentionally unsupported");
    const bb = this.client();
    const context = await bb.contexts.create({ projectId: config().projectId, name: `canvas-${digest(input.ownerId).slice(0, 24)}-${Date.now()}` });
    try {
      const session = await this.startSession(bb, context.id, input.canvasOrigin, input.authHostRules, digest(input.ownerId).slice(0, 32));
      await withBrowser(bb, { sessionId: session.id, contextId: context.id, canvasOrigin: input.canvasOrigin, authHostRules: input.authHostRules, loginPath: input.loginPath }, async (_browser, page) => {
        await page.goto(input.canvasOrigin, { waitUntil: "domcontentloaded" });
      });
      return { providerSessionId: encodeHandle({ sessionId: session.id, contextId: context.id, canvasOrigin: input.canvasOrigin, authHostRules: input.authHostRules, loginPath: input.loginPath }) };
    } catch (error) {
      await bb.contexts.delete(context.id).catch(() => undefined);
      throw error;
    }
  }

  async interactiveConnect(providerSessionId: string) {
    const handle = decodeHandle(providerSessionId);
    await this.navigate(providerSessionId, "canvas-login");
    const expiresIn = 300;
    const links = await this.client().sessions.debug(handle.sessionId, { expiresIn });
    return { url: links.debuggerFullscreenUrl, expiresAt: Date.now() + expiresIn * 1000 };
  }

  async status(providerSessionId: string): Promise<{ state: Exclude<HostedSessionState, "terminated">; canvasAccountId?: string; authRequired?: boolean }> {
    const handle = decodeHandle(providerSessionId);
    const bb = this.client();
    const session = await bb.sessions.retrieve(handle.sessionId);
    if (session.status === "ERROR") return { state: "failed" };
    if (session.status === "TIMED_OUT" || session.status === "COMPLETED") return { state: "auth-expired", authRequired: true };
    if (session.status === "PENDING") return { state: "provisioning" };
    try {
      return await withBrowser(bb, handle, async (_browser, page) => {
        const response = await page.evaluate(async ({ origin }) => {
          const result = await fetch(`${origin}/api/v1/users/self`, { credentials: "include", redirect: "follow", headers: { accept: "application/json" } });
          return { ok: result.ok, status: result.status, url: result.url, data: result.ok ? await result.json() : null };
        }, { origin: handle.canvasOrigin });
        const authenticated = response.ok && response.url.startsWith(`${handle.canvasOrigin}/api/`);
        return authenticated ? { state: "active" as const, canvasAccountId: String((response.data as { id?: unknown })?.id ?? "") } : { state: "awaiting-login" as const, authRequired: true };
      });
    } catch { return { state: "failed" }; }
  }

  // No execute(): the browser is login-only (see lib/canvas/session-client.ts).

  async snapshotEncrypted(providerSessionId: string, ownerId: string) {
    const handle = decodeHandle(providerSessionId);
    return withBrowser(this.client(), handle, async (browser) => {
      const state = await browser.contexts()[0].storageState();
      return envelopeEncryptBrowserState(state, ownerId);
    });
  }

  async navigate(providerSessionId: string, destination: "canvas-home" | "canvas-login") {
    const handle = decodeHandle(providerSessionId);
    await withBrowser(this.client(), handle, async (_browser, page) => {
      // Canvas itself decides the institution-specific login/SSO redirect. The agent
      // never sees or fills credentials; the user takes over through Live View.
      const target = destination === "canvas-login" ? `${handle.canvasOrigin}${handle.loginPath}` : handle.canvasOrigin;
      await page.goto(target, { waitUntil: "domcontentloaded" });
    });
  }

  async relinquishInteractive(providerSessionId: string) {
    const handle = decodeHandle(providerSessionId);
    const bb = this.client();
    // Ending the live-view session invalidates its takeover URL. The encrypted
    // Browserbase Context carries authentication into a fresh automation session.
    await bb.sessions.update(handle.sessionId, { status: "REQUEST_RELEASE", projectId: config().projectId });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const released = await bb.sessions.retrieve(handle.sessionId);
      if (["COMPLETED", "ERROR", "TIMED_OUT"].includes(released.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const replacement = await this.startSession(bb, handle.contextId, handle.canvasOrigin, handle.authHostRules);
    return { providerSessionId: encodeHandle({ ...handle, sessionId: replacement.id }) };
  }

  async terminate(providerSessionId: string) {
    const handle = decodeHandle(providerSessionId);
    const bb = this.client();
    await bb.sessions.update(handle.sessionId, { status: "REQUEST_RELEASE", projectId: config().projectId }).catch(() => undefined);
    await bb.contexts.delete(handle.contextId);
  }
}
