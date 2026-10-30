export type InlineNode =
  | { type: "text"; value: string }
  | { type: "bold" | "italic" | "code"; children: InlineNode[] }
  | { type: "link"; label: string; url: string };

/** Parses only the inline subset supported by the contract. Unrecognized markup stays text. */
export function parseInlineMarkdown(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", value: text });
    text = "";
  };
  for (let i = 0; i < input.length;) {
    const markers = ["**", "*", "`"] as const;
    const marker = markers.find((value) => input.startsWith(value, i));
    if (marker) {
      const end = input.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        flush();
        const content = input.slice(i + marker.length, end);
        nodes.push({
          type: marker === "**" ? "bold" : marker === "*" ? "italic" : "code",
          children: [{ type: "text", value: content }],
        });
        i = end + marker.length;
        continue;
      }
    }
    if (input[i] === "[") {
      const close = input.indexOf("](", i + 1),
        end = close < 0 ? -1 : input.indexOf(")", close + 2);
      if (close > i + 1 && end > close + 2) {
        const url = input.slice(close + 2, end);
        if (/^(https?:|mailto:)/i.test(url)) {
          flush();
          nodes.push({ type: "link", label: input.slice(i + 1, close), url });
          i = end + 1;
          continue;
        }
      }
    }
    text += input[i];
    i++;
  }
  flush();
  return nodes;
}

export function serializeInlineMarkdown(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value;
      if (node.type === "link") return `[${node.label}](${node.url})`;
      const value = serializeInlineMarkdown(node.children);
      const marker = node.type === "bold" ? "**" : node.type === "italic" ? "*" : "`";
      return marker + value + marker;
    })
    .join("");
}

export function inlineMarkdownToPlainText(input: string): string {
  return parseInlineMarkdown(input)
    .map((node) =>
      node.type === "text" ? node.value : node.type === "link" ? node.label : inlineNodeText(node.children),
    )
    .join("");
}

function inlineNodeText(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text" ? node.value : node.type === "link" ? node.label : inlineNodeText(node.children),
    )
    .join("");
}
