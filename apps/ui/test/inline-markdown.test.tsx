// @vitest-environment jsdom
import fc from "fast-check";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InlineText, parseInlineMarkdown, serializeInlineMarkdown } from "../src/document/inline-markdown.js";

afterEach(cleanup);

it("round-trips the supported inline formatting subset", () => {
  const source = "Plain **bold** and *italic*, `code`, [link](https://example.test/path).";
  expect(serializeInlineMarkdown(parseInlineMarkdown(source))).toBe(source);
});

it("never turns arbitrary text into untrusted HTML", () => {
  fc.assert(
    fc.property(fc.string(), (source) => {
      const { container } = render(<InlineText text={source} />);
      expect(container.querySelector("script, iframe, img, svg, style, object")).toBeNull();
      for (const element of container.querySelectorAll("*"))
        expect(["STRONG", "EM", "CODE", "A"]).toContain(element.tagName);
      cleanup();
    }),
  );
});

it("renders links without injecting markup", () => {
  const { container } = render(<InlineText text={"[<img>](https://example.test)"} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")?.textContent).toBe("<img>");
});
// @vitest-environment jsdom
