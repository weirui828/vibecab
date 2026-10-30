import { expect, it } from "vitest";
import { inlineMarkdownToPlainText } from "../src/inline-markdown.js";

it("removes supported formatting while preserving visible text", () => {
  expect(inlineMarkdownToPlainText("A **bold** *word*, `code`, [link](https://example.test).")).toBe(
    "A bold word, code, link.",
  );
});
