import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /(?:theme|popup-lifecycle|manual-sync)\.spec\.ts/,
  outputDir: ".theme-test-results",
  timeout: 45_000,
  use: {
    baseURL: process.env.CANVAS_GROVE_URL ?? "http://127.0.0.1:3127",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  reporter: [["list"]],
});
