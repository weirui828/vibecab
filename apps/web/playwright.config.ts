import { defineConfig } from "@playwright/test";

// End-to-end: the built web app in Chromium against a real engine with the scripted model (see e2e/host.ts).
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results",
  use: { browserName: "chromium", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
