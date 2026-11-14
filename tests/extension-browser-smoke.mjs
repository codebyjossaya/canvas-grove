import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GROVE_ORIGIN } from "../extension/dist/config.js";

const extensionPath = resolve("extension/dist");
const profile = await mkdtemp(`${tmpdir()}/grove-extension-smoke-`);
const cdpUrl = process.env.PLAYWRIGHT_CDP_URL;
const browser = cdpUrl ? await chromium.connectOverCDP(cdpUrl) : null;
const context = browser?.contexts()[0] ?? await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const visibleHeading = popup.locator("h1:visible");
  await visibleHeading.waitFor();
  assert.equal(await visibleHeading.textContent(), "Connect to Canvas Grove");
  assert.match(await popup.locator("main").innerText(), /institution password is never sent to Grove/i);

  const grove = await context.newPage();
  await grove.goto(`${GROVE_ORIGIN}/landing`, { waitUntil: "domcontentloaded" });
  const state = await grove.evaluate(() => new Promise((resolveState, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error("extension bridge timed out")), 5_000);
    const receive = (event) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== "grove-extension" || event.data?.type !== "canvas-auth-result" || event.data?.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolveState(event.data.result);
    };
    window.addEventListener("message", receive);
    window.postMessage({ source: "grove-web", type: "canvas-auth-state", requestId }, window.location.origin);
  }));
  assert.deepEqual(state, { ok: true, installed: true, paired: false, canvasOrigin: null });
  console.log(JSON.stringify({ ok: true, extensionId, groveOrigin: GROVE_ORIGIN, bridge: state }));
} finally {
  if (browser) await browser.close();
  else await context.close();
}
