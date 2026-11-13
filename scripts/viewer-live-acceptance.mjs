import { chromium } from "playwright-core";

const target = process.env.VIEWER_ACCEPTANCE_URL;
const base = process.env.VIEWER_ACCEPTANCE_BASE ?? "https://canvas-grove.tail8dc4e4.ts.net";
const executablePath = process.env.VIEWER_ACCEPTANCE_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!target) throw new Error("VIEWER_ACCEPTANCE_URL is required");

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const responses = [];
const failedRequests = [];
const sockets = [];
const messages = [];
let websocketFrames = 0;

page.on("response", (response) => {
  const url = response.url();
  if (url.includes("/live/") || url.includes("/viewer/")) {
    responses.push({ path: new URL(url).pathname, status: response.status(), type: response.request().resourceType() });
  }
});
page.on("requestfailed", (request) => {
  const url = request.url();
  if (url.includes("/live/") || url.includes("/viewer/")) {
    failedRequests.push({ path: new URL(url).pathname, error: request.failure()?.errorText ?? "unknown" });
  }
});
page.on("websocket", (socket) => {
  const path = new URL(socket.url()).pathname;
  if (!path.endsWith("/websockify")) return;
  sockets.push(path);
  socket.on("framereceived", () => { websocketFrames += 1; });
});

try {
  await page.route(`${base}/__viewer_acceptance__`, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><body style='margin:0'></body></html>",
  }));
  await page.goto(`${base}/__viewer_acceptance__`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.evaluate((url) => {
    window.__viewerMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.source === "canvas-grove-viewer") window.__viewerMessages.push(event.data);
    });
    document.body.innerHTML = '<main style="width:100vw;height:100vh"><iframe title="Secure Canvas live browser" style="display:block;width:100%;height:100%;border:0"></iframe></main>';
    document.querySelector("iframe").src = url;
  }, target);

  const iframe = page.locator('iframe[title="Secure Canvas live browser"]');
  await iframe.waitFor({ state: "visible", timeout: 10_000 });
  const deadline = Date.now() + 20_000;
  let viewer;
  while (Date.now() < deadline && !viewer) {
    viewer = page.frames().find((item) => item !== page.mainFrame() && item.url().includes("/viewer/"));
    if (!viewer) await page.waitForTimeout(100);
  }
  if (!viewer) throw new Error("Viewer iframe never reached the secure viewer document");

  await viewer.waitForFunction(() => document.documentElement.dataset.state === "connected", null, { timeout: 30_000 });
  await viewer.locator("#screen canvas").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => window.__viewerMessages?.some((item) => item.type === "ws-ready"), null, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);

  const box = await iframe.boundingBox();
  const readCanvas = () => viewer.locator("#screen canvas").evaluate((element) => ({
    width: element.width,
    height: element.height,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    ...(() => {
      const context = element.getContext("2d");
      if (!context) return { sampledColors: 0, luminanceRange: 0, nonDarkSamples: 0 };
      const colors = new Set(); let minimum = 255, maximum = 0, nonDarkSamples = 0;
      for (let y = 0; y < element.height; y += Math.max(1, Math.floor(element.height / 30))) {
        for (let x = 0; x < element.width; x += Math.max(1, Math.floor(element.width / 40))) {
          const pixel = context.getImageData(x, y, 1, 1).data;
          const luminance = Math.round((pixel[0] + pixel[1] + pixel[2]) / 3);
          minimum = Math.min(minimum, luminance); maximum = Math.max(maximum, luminance);
          if (luminance > 20) nonDarkSamples += 1;
          colors.add(`${pixel[0] >> 4},${pixel[1] >> 4},${pixel[2] >> 4}`);
        }
      }
      return { sampledColors: colors.size, luminanceRange: maximum - minimum, nonDarkSamples };
    })(),
  }));
  let canvas = await readCanvas();
  const contentDeadline = Date.now() + 15_000;
  while (Date.now() < contentDeadline && (canvas.sampledColors < 4 || canvas.luminanceRange < 20 || canvas.nonDarkSamples < 20)) {
    await page.waitForTimeout(250);
    canvas = await readCanvas();
  }
  messages.push(...await page.evaluate(() => window.__viewerMessages ?? []));
  const badModules = responses.filter((item) => /\.(?:js|css)$/.test(item.path) && (item.status < 200 || item.status >= 300));
  const failureMessages = messages.filter((item) => ["failed", "disconnected", "authorization-expired"].includes(item.type));
  if (!box || box.width < 640 || box.height < 480) throw new Error(`Viewer iframe is not visibly mounted: ${JSON.stringify(box)}`);
  if (badModules.length) throw new Error(`Viewer module graph failed: ${JSON.stringify(badModules)}`);
  for (const required of ["/core/util/browser.js", "/core/decoders/tightpng.js"]) {
    if (!responses.some((item) => item.path.endsWith(required) && item.status === 200)) throw new Error(`Required viewer module did not load successfully: ${required}`);
  }
  if (failedRequests.length) throw new Error(`Viewer requests failed: ${JSON.stringify(failedRequests)}`);
  if (!sockets.length || websocketFrames === 0) throw new Error("Viewer never established a live WebSocket framebuffer stream");
  if (canvas.width === 0 || canvas.height === 0 || canvas.clientWidth === 0 || canvas.clientHeight === 0) throw new Error(`Viewer canvas is blank-sized: ${JSON.stringify(canvas)}`);
  if (canvas.sampledColors < 4 || canvas.luminanceRange < 20 || canvas.nonDarkSamples < 20) throw new Error(`Viewer framebuffer does not contain visible page content: ${JSON.stringify(canvas)}`);
  if (failureMessages.length) throw new Error(`Viewer reported failure: ${JSON.stringify(failureMessages)}`);

  const firstSocketCount = sockets.length, firstFrameCount = websocketFrames;
  await viewer.goto(viewer.url(), { waitUntil: "domcontentloaded", timeout: 20_000 });
  await viewer.waitForFunction(() => document.documentElement.dataset.state === "connected", null, { timeout: 30_000 });
  await viewer.locator("#screen canvas").waitFor({ state: "visible", timeout: 10_000 });
  const reconnectDeadline = Date.now() + 5_000;
  while (Date.now() < reconnectDeadline && sockets.length <= firstSocketCount) await page.waitForTimeout(100);
  if (sockets.length <= firstSocketCount) throw new Error("Reloading the embedded viewer did not reconnect its WebSocket");
  if (websocketFrames <= firstFrameCount) throw new Error("Reloaded viewer WebSocket did not deliver framebuffer data");

  await page.screenshot({ path: ".viewer-acceptance.png", fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    iframe: { width: Math.round(box.width), height: Math.round(box.height) },
    canvas,
    viewerResponses: responses.length,
    moduleResponses: responses.filter((item) => /\.(?:js|css)$/.test(item.path)).length,
    websocketConnections: sockets.length,
    websocketFrames,
    messages: messages.map((item) => item.type),
  }));
} finally {
  await context.close();
  await browser.close();
}
