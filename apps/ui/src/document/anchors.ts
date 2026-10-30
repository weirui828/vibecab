import { inlineMarkdownToPlainText } from "../../../../contract/src/inline-markdown.js";

export function locatorForTextSelection(markdown: string, start: number, end: number) {
  const plain = inlineMarkdownToPlainText(markdown),
    from = Math.max(0, Math.min(start, plain.length)),
    to = Math.max(from, Math.min(end, plain.length));
  return {
    quote: plain.slice(from, to),
    prefix: plain.slice(Math.max(0, from - 32), from),
    suffix: plain.slice(to, to + 32),
  };
}
