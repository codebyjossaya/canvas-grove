import { chromium } from "playwright-core";

const origin = process.argv[2];
if (!origin?.startsWith("https://")) throw new Error("Expected an HTTPS origin");

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});

try {
  const page = await browser.newPage();
  let handshakeRequests = 0;
  let oauthRequests = 0;
  let consoleErrorCount = 0;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("__clerk_handshake")) handshakeRequests += 1;
    if (/accounts\.google\.com|oauth.*google|v1\/client.*oauth/i.test(url)) oauthRequests += 1;
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrorCount += 1;
  });

  await page.goto(origin, { waitUntil: "networkidle", timeout: 30_000 });
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForTimeout(2_000);
  const google = page.getByRole("button", { name: /google/i }).first();
  const googleButtonVisible = await google.isVisible().catch(() => false);
  if (googleButtonVisible) {
    await google.click();
    await page.waitForTimeout(5_000);
  }

  console.log(JSON.stringify({
    finalOrigin: new URL(page.url()).origin,
    googleButtonVisible,
    googleOAuthInitiated: oauthRequests > 0 || /accounts\.google\.com/.test(page.url()),
    handshakeRequests,
    handshakeLoopDetected: handshakeRequests > 2,
    consoleErrorCount,
  }));
} finally {
  await browser.close();
}
