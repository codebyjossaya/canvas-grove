import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /ui-forward-preview\.spec\.ts/,
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3101",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  webServer: { command: "node e2e/run-ui-forward-server.cjs", cwd: "..", url: "http://127.0.0.1:3101/ui-preview?mode=course", reuseExistingServer: true, timeout: 120_000 },
  reporter: [["list"]],
});
