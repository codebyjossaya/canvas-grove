import { createHmac, randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { EncryptedBrowserState, HostedBrowserProvider, HostedSessionState } from "../hosted-browser";
import type { DisplaySize } from "../display";
import { envelopeDecryptBrowserState, envelopeEncryptBrowserState } from "./envelope";
import { BridgeError } from "../errors";
import { isAllowedInstitutionUrl, toCanvasLoginPath, type CanvasLoginPath } from "@/lib/canvas/institution";
import { lookup } from "node:dns/promises";
import { isPublicAddress } from "@/lib/canvas/network-policy";

type Handle = { id: string; canvasOrigin: string; authHostRules: string[]; loginPath: CanvasLoginPath; display?: DisplaySize };

async function isAllowedPublicInstitutionUrl(value: string, canvasOrigin: string, authHostRules: string[]): Promise<boolean> {
  if (!isAllowedInstitutionUrl(value, canvasOrigin, authHostRules)) return false;
  try {
    const addresses = await lookup(new URL(value).hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch { return false; }
}

function blockedRedirect(value: string): BridgeError {
  let blockedHost: string | undefined;
  try {
    const candidate = new URL(value).hostname.toLowerCase();
    if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate)) blockedHost = candidate;
  } catch { /* do not reflect an unparsed URL */ }
  return new BridgeError("BROWSER_NAVIGATION_BLOCKED", "The sign-in redirect was blocked for safety.", 400, blockedHost);
}
const encode = (value: Handle) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string): Handle => {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Handle;
  return { ...parsed, loginPath: toCanvasLoginPath(parsed.loginPath) };
};

function gatewayConfig() {
  const baseUrl = process.env.BROWSER_ORCHESTRATOR_URL;
  const secret = process.env.BROWSER_ORCHESTRATOR_SECRET;
  if (!baseUrl || !secret) throw new Error("BROWSER_ORCHESTRATOR_URL and BROWSER_ORCHESTRATOR_SECRET are required");
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret };
}

async function gateway<T>(method: string, path: string, value?: unknown): Promise<T> {
  const { baseUrl, secret } = gatewayConfig();
  const body = value === undefined ? "" : JSON.stringify(value);
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`).digest("base64url");
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", "x-orchestrator-timestamp": timestamp, "x-orchestrator-nonce": nonce, "x-orchestrator-signature": signature }, body: body || undefined, cache: "no-store", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new BridgeError("BROWSER_HOST_OFFLINE", "The browser host is unavailable. Try again shortly."); }
  const result = await response.json().catch(() => ({})) as { code?: string };
  if (!response.ok) {
    if (response.status === 401) throw new BridgeError("BROWSER_HOST_AUTH", "The browser host rejected the request.");
    if (response.status === 404) throw new BridgeError("BROWSER_SESSION_NOT_FOUND", "The secure browser session no longer exists.", 404);
    if (response.status === 429) throw new BridgeError("BROWSER_HOST_CAPACITY", "The browser host is at capacity. Try again shortly.", 429);
    if (result.code === "NAVIGATION_BLOCKED") throw new BridgeError("BROWSER_NAVIGATION_BLOCKED", "The sign-in redirect was blocked for safety.", 400);
    throw new BridgeError("BROWSER_HOST_ERROR", "The secure browser could not complete the request.");
  }
  return result as T;
}

async function withBrowser<T>(id: string, callback: (browser: Browser, page: Page) => Promise<T>): Promise<T> {
  const session = await gateway<{ cdpUrl: string }>("GET", `/v1/sessions/${encodeURIComponent(id)}/connect`);
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    return await callback(browser, page);
  } finally { await browser.close(); }
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function navigateForInteractiveLogin(page: Page, target: string, handle: Handle, alreadyNavigating = false) {
  const context = page.context();
  let navigationAborted = false;
  try {
    if (alreadyNavigating) throw new Error("navigation-already-started");
    await page.goto(target, { waitUntil: "commit", timeout: 30_000 });
  } catch (error) {
    if (alreadyNavigating && error instanceof Error && error.message === "navigation-already-started") {
      // The orchestrator opened this guarded target through Chromium directly.
    } else {
    navigationAborted = error instanceof Error && error.message.includes("net::ERR_ABORTED");
    if (!navigationAborted) throw error;
    await pause(250);
    if (["", "about:blank"].includes(page.url())) {
      // A competing renderer navigation can abort Playwright before it commits.
      // Retry at the Chromium Page domain, then validate every resulting URL.
      const session = await context.newCDPSession(page);
      try {
        const result = await session.send("Page.navigate", { url: target });
        if (result.errorText && !result.errorText.includes("net::ERR_ABORTED")) throw new Error("Canvas sign-in navigation failed");
      } finally { await session.detach(); }
    }
    }
  }

  // SAML handoffs can replace the original navigation or open a new page. Wait
  // for the top-level URL to settle, but never follow an unexpected origin.
  let selected = page;
  let previous = "";
  let stableSamples = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = context.pages();
    const candidates = pages.filter((candidate) => !["", "about:blank"].includes(candidate.url()));
    for (const candidate of candidates) {
      if (!await isAllowedPublicInstitutionUrl(candidate.url(), handle.canvasOrigin, handle.authHostRules)) {
        throw blockedRedirect(candidate.url());
      }
    }
    selected = candidates.at(-1) ?? selected;
    const current = selected.url();
    if (await isAllowedPublicInstitutionUrl(current, handle.canvasOrigin, handle.authHostRules) && current === previous) stableSamples += 1;
    else stableSamples = 0;
    previous = current;
    if (stableSamples >= 2) {
      await selected.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      return;
    }
    await pause(350);
  }
  if (navigationAborted && await isAllowedPublicInstitutionUrl(selected.url(), handle.canvasOrigin, handle.authHostRules)) return;
  throw new BridgeError("BROWSER_HOST_ERROR", "The secure browser could not reach the sign-in page.");
}

export class SelfHostedChromiumProvider implements HostedBrowserProvider {
  async provision(input: { ownerId: string; canvasOrigin: string; authHostRules: string[]; loginPath: CanvasLoginPath; display?: DisplaySize; encryptedState?: EncryptedBrowserState }) {
    const created = await gateway<{ id: string }>("POST", "/v1/sessions", { canvasOrigin: input.canvasOrigin, authHostRules: input.authHostRules, loginPath: input.loginPath, display: input.display });
    const providerSessionId = encode({ id: created.id, canvasOrigin: input.canvasOrigin, authHostRules: input.authHostRules, loginPath: input.loginPath, display: input.display });
    if (!input.encryptedState) return { providerSessionId };
    try {
      let restored: { cookies?: unknown; origins?: unknown };
      try { restored = envelopeDecryptBrowserState(input.encryptedState, input.ownerId) as { cookies?: unknown; origins?: unknown }; }
      catch { throw new BridgeError("BROWSER_AUTH_EXPIRED", "The saved Canvas session cannot be restored. Reconnect Canvas.", 401); }
      const cookies = Array.isArray(restored?.cookies) ? restored.cookies : [];
      await withBrowser(created.id, async (_browser, page) => {
        if (cookies.length) await page.context().addCookies(cookies as Parameters<BrowserContext["addCookies"]>[0]);
        await page.goto(input.canvasOrigin, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const originState = Array.isArray(restored?.origins) ? restored.origins.find((item) => {
          return typeof item === "object" && item !== null && (item as { origin?: unknown }).origin === input.canvasOrigin;
        }) as { localStorage?: Array<{ name: string; value: string }> } | undefined : undefined;
        if (originState?.localStorage?.length) {
          await page.evaluate((entries) => {
            for (const entry of entries) if (typeof entry.name === "string" && typeof entry.value === "string") localStorage.setItem(entry.name, entry.value);
          }, originState.localStorage);
        }
      });
      return { providerSessionId };
    } catch (error) {
      await gateway("DELETE", `/v1/sessions/${encodeURIComponent(created.id)}`).catch(() => undefined);
      throw error;
    }
  }
  async interactiveConnect(value: string) {
    const handle = decode(value);
    try {
      // A client can disconnect after the orchestrator issues a one-time live
      // grant but before the app receives/persists the response (HTTP 499).
      // Make retries idempotent by revoking any abandoned grant first.
      await gateway("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/revoke-live`).catch((error) => {
        if (error instanceof BridgeError && error.code === "BROWSER_SESSION_NOT_FOUND") throw error;
      });
      await gateway("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/navigate`, { url: `${handle.canvasOrigin}${handle.loginPath}` });
      // Do not expose the viewer until the guarded login target is committed,
      // visible, and the initial about:blank tab has been removed.
      await withBrowser(handle.id, async (_browser, initialPage) => {
        const context = initialPage.context();
        const targetPage = context.pages().find((page) => isAllowedInstitutionUrl(page.url(), handle.canvasOrigin, handle.authHostRules)) ?? context.pages().at(-1) ?? initialPage;
        await navigateForInteractiveLogin(targetPage, targetPage.url(), handle, true);
        await targetPage.bringToFront();
        for (const page of context.pages()) {
          if (page !== targetPage && ["", "about:blank"].includes(page.url())) await page.close().catch(() => undefined);
        }
      });
      return await gateway<{ url: string; expiresAt: number }>("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/live`);
    } catch (error) {
      await gateway("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/revoke-live`).catch(() => undefined);
      throw error;
    }
  }
  async status(value: string): Promise<{ state: Exclude<HostedSessionState, "terminated">; canvasAccountId?: string; authRequired?: boolean }> {
    const handle = decode(value);
    const status = await gateway<{ state: string }>("GET", `/v1/sessions/${encodeURIComponent(handle.id)}`);
    if (status.state !== "running") return { state: status.state === "starting" ? "provisioning" : "failed" };
    try {
      return await withBrowser(handle.id, async (_browser, initialPage) => {
        const pages = initialPage.context().pages();
        const page = pages.find((candidate) => isAllowedInstitutionUrl(candidate.url(), handle.canvasOrigin, handle.authHostRules));
        // A running container with no committed, allowlisted renderer is not a
        // normal "awaiting login" state. It is the observable signature of a
        // dead renderer/network service and must be repaired by the durable
        // monitor instead of leaving the user looking at a blank framebuffer.
        if (!page) throw new BridgeError("BROWSER_HOST_ERROR", "The secure browser renderer is unavailable.");
        if (new URL(page.url()).origin !== handle.canvasOrigin) {
          return { state: "awaiting-login" as const, authRequired: true };
        }
        const probe = await page.evaluate(async (origin) => { const response = await fetch(`${origin}/api/v1/users/self`, { credentials: "include", redirect: "follow" }); return { ok: response.ok, url: response.url, data: response.ok ? await response.json() : null }; }, handle.canvasOrigin);
        return probe.ok && probe.url.startsWith(`${handle.canvasOrigin}/api/`) ? { state: "active" as const, canvasAccountId: String((probe.data as { id?: unknown })?.id ?? "") } : { state: "awaiting-login" as const, authRequired: true };
      });
    } catch (error) {
      if (error instanceof BridgeError && ["BROWSER_SESSION_NOT_FOUND", "BROWSER_HOST_ERROR", "BROWSER_HOST_OFFLINE", "BROWSER_HOST_AUTH"].includes(error.code)) throw error;
      return { state: "awaiting-login", authRequired: true };
    }
  }
  // No execute(): the browser is login-only. Canvas API calls (sync and app)
  // go through lib/canvas/session-client.ts with the captured cookie jar.
  async navigate(value: string, destination: "canvas-home" | "canvas-login") {
    const handle = decode(value);
    const target = destination === "canvas-login" ? `${handle.canvasOrigin}${handle.loginPath}` : handle.canvasOrigin;
    await withBrowser(handle.id, async (_browser, page) => {
      await gateway("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/navigate`, { url: target });
      const pages = page.context().pages();
      const targetPage = pages.at(-1) ?? page;
      try { await navigateForInteractiveLogin(targetPage, targetPage.url(), handle, true); }
      catch (error) {
        if (error instanceof BridgeError && error.code === "BROWSER_NAVIGATION_BLOCKED") throw error;
        await gateway("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/navigate`, { url: target });
        await navigateForInteractiveLogin(page.context().pages().at(-1) ?? page, target, handle, true);
      }
    });
  }
  async relinquishInteractive(value: string) {
    const handle = decode(value);
    await gateway("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/revoke-live`);
    return { providerSessionId: value };
  }
  async snapshotEncrypted(value: string, ownerId: string) {
    const handle = decode(value);
    return withBrowser(handle.id, async (browser) => envelopeEncryptBrowserState(await browser.contexts()[0].storageState(), ownerId));
  }
  async terminate(value: string) {
    const handle = decode(value);
    await gateway("DELETE", `/v1/sessions/${encodeURIComponent(handle.id)}`);
  }
}
