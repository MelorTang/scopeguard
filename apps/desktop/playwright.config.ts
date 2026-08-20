import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/renderer",
  outputDir: "../../output/playwright/test-results",
  reporter: "line",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev:web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
