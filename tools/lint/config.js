import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: ["contract/generated/**", "**/node_modules/**", "docs/**", "archive/**", "dist/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "max-len": ["error", { code: 160, ignoreUrls: true }],
    },
  },
  {
    files: ["engine/src/{content,feedback,updates,agent,tmr,integration}/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: ["better-sqlite3"], patterns: ["adapters/*", "**/adapters/*"] }],
    },
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
