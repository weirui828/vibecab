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

/** Replaces a visible-text range while retaining formatting outside that range. */
export function replaceInlineMarkdownText(input: string, start: number, end: number, replacement: string): string {
  const nodes = parseInlineMarkdown(input),
    plainLength = inlineNodeText(nodes).length;
  if (start < 0 || end < start || end > plainLength) throw new RangeError("Invalid inline text range");
  const before = sliceInlineNodes(nodes, 0, start),
    after = sliceInlineNodes(nodes, end, plainLength);
  return serializeInlineMarkdown([
    ...before,
    ...(replacement ? [{ type: "text" as const, value: replacement }] : []),
    ...after,
  ]);
}

function sliceInlineNodes(nodes: InlineNode[], start: number, end: number): InlineNode[] {
  const result: InlineNode[] = [];
  let offset = 0;
  for (const node of nodes) {
    const length =
      node.type === "text"
        ? node.value.length
        : node.type === "link"
          ? node.label.length
          : inlineNodeText(node.children).length;
    const localStart = Math.max(0, start - offset),
      localEnd = Math.min(length, end - offset);
    if (localStart < localEnd) {
      if (node.type === "text") result.push({ type: "text", value: node.value.slice(localStart, localEnd) });
      else if (node.type === "link")
        result.push({ type: "link", label: node.label.slice(localStart, localEnd), url: node.url });
      else {
        const children = sliceInlineNodes(node.children, localStart, localEnd);
        if (children.length) result.push({ type: node.type, children });
      }
    }
    offset += length;
  }
  return result;
}

function inlineNodeText(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text" ? node.value : node.type === "link" ? node.label : inlineNodeText(node.children),
    )
    .join("");
}

/**
 * Finds an anchor's quote in an element's plain text: the quote with its prefix and suffix if that context
 * occurs exactly once, otherwise the quote alone if it occurs exactly once. Shared by the engine and clients.
 */
export function locateQuote(
  plain: string,
  locator: { quote: string; prefix: string; suffix: string },
): { start: number; end: number } | undefined {
  const { quote, prefix, suffix } = locator;
  const unique = (value: string) => {
    const at = plain.indexOf(value);
    return at >= 0 && plain.indexOf(value, at + 1) < 0 ? at : undefined;
  };
  const context = unique(prefix + quote + suffix),
    at = context === undefined ? unique(quote) : context + prefix.length;
  return at === undefined ? undefined : { start: at, end: at + quote.length };
}
