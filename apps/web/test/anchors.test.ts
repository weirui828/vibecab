import { expect, it } from "vitest";
import { inlineMarkdownToPlainText } from "../../../contract/src/inline-markdown.js";
import { locatorForTextSelection } from "../src/document/anchors.js";

it("builds the exact normalized quote and bounded context for a selection", () => {
  const source = "Intro **bold words** and more text for context.";
  const plain = inlineMarkdownToPlainText(source),
    start = plain.indexOf("bold words"),
    end = start + "bold words".length;
  expect(locatorForTextSelection(source, start, end)).toEqual({
    quote: "bold words",
    prefix: "Intro ",
    suffix: " and more text for context.",
  });
});

it("caps locator prefix and suffix at 32 visible characters", () => {
  const source = "x".repeat(40) + "SELECT" + "y".repeat(40),
    start = 40,
    end = 46,
    locator = locatorForTextSelection(source, start, end);
  expect(locator).toEqual({ quote: "SELECT", prefix: "x".repeat(32), suffix: "y".repeat(32) });
});
