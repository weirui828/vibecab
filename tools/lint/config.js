import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "contract/generated/**",
      "**/node_modules/**",
      "docs/**",
      "archive/**",
      "dist/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
