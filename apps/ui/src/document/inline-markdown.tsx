import type { ReactNode } from "react";
import {
  inlineMarkdownToPlainText,
  parseInlineMarkdown as parse,
  serializeInlineMarkdown as serialize,
  type InlineNode,
} from "../../../../contract/src/inline-markdown.js";

export { inlineMarkdownToPlainText, type InlineNode };
export const parseInlineMarkdown = parse;
export const serializeInlineMarkdown = serialize;

export function InlineText({ text }: { text: string }) {
  const render = (nodes: InlineNode[]): ReactNode =>
    nodes.map((node, index) => {
      if (node.type === "text") return node.value;
      if (node.type === "link")
        return (
          <a
            key={index}
            href={node.url}
            onClick={(event) => {
              event.preventDefault();
              void window.vibecab.app.openExternal(node.url);
            }}
          >
            {node.label}
          </a>
        );
      const content = render(node.children);
      return node.type === "bold" ? (
        <strong key={index}>{content}</strong>
      ) : node.type === "italic" ? (
        <em key={index}>{content}</em>
      ) : (
        <code key={index}>{content}</code>
      );
    });
  return <>{render(parse(text))}</>;
}
