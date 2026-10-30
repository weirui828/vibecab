import { defineConfig } from "vitest/config";
export default defineConfig({ test: { testTimeout: 60000, exclude: ["**/node_modules/**", "**/dist/**", "apps/macos/e2e/**"] } });
