import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  retries: 0,
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: /global\.setup\.ts/,
      use: {
        baseURL: process.env.CANVAS_GROVE_URL ?? "https://canvas-grove.tail8dc4e4.ts.net",
        browserName: "chromium",
        headless: true,
        launchOptions: { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
      },
    },
  ],
  reporter: [["list"]],
});
