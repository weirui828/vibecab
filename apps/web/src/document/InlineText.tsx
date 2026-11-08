import type { ReactNode } from "react";
import { parseInlineMarkdown } from "../../../../contract/src/inline-markdown.js";
import type { InlineNode } from "../../../../contract/src/inline-markdown.js";

/** Only these schemes become links; anything else (javascript:, data:, relative paths) stays text. */
export function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function render(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type === "link") {
      const href = safeHref(node.url);
      return href ? (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {node.label}
        </a>
      ) : (
        <span key={index}>{node.label}</span>
      );
    }
    const content = render(node.children);
    if (node.type === "bold") return <strong key={index}>{content}</strong>;
    if (node.type === "italic") return <em key={index}>{content}</em>;
    return <code key={index}>{content}</code>;
  });
}

/** The validated inline subset (bold, italic, code, links) as React elements. Text is never parsed as HTML. */
export function InlineText({ text }: { text: string }) {
  return <>{render(parseInlineMarkdown(text))}</>;
}
