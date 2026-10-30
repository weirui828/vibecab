import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 60000,
    setupFiles: ["./scripts/vitest-setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/macos/build/**", "apps/macos/e2e/**"],
  },
});
