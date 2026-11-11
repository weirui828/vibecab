import { parseFragment } from "parse5";

// What the contract needs to know about a piece of HTML: is it exactly one element, and what does it say.
// The tree types are parse5's; only the few fields read here are named.

interface Node {
  nodeName: string;
  value?: string;
  childNodes?: Node[];
  content?: { childNodes: Node[] };
}

const blank = (node: Node) => node.nodeName === "#text" && (node.value ?? "").trim() === "";
const silent = new Set(["script", "style", "template", "noscript"]);

/** The one element this HTML is, or undefined when it is none, several, or has loose text beside it. */
function soleElement(html: string): Node | undefined {
  const nodes = (parseFragment(html) as Node).childNodes ?? [],
    [only] = nodes;
  return nodes.length === 1 && only && !only.nodeName.startsWith("#") ? only : undefined;
}

/** An `html_block` holds exactly one element, with nothing before or after it. */
export function isOneHtmlElement(html: string): boolean {
  return soleElement(html) !== undefined;
}

/** The tag of the one element this HTML is. */
export function htmlTag(html: string): string | undefined {
  return soleElement(html)?.nodeName;
}

/** What a reader sees of the HTML as plain words: text in order, spaces folded, nothing from scripts or styles. */
export function htmlPlainText(html: string): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeName === "#text") parts.push(node.value ?? "");
    else if (!silent.has(node.nodeName) && !blank(node)) for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parseFragment(html) as Node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
