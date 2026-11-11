import { parse, serialize, serializeOuter } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { CommitInput, ElementDraft } from "../../../contract/src/index.js";
import { htmlPlainText } from "../../../contract/src/index.js";

// An HTML file as a Draft, and back. The file is kept as it is: an element that only groups blocks becomes a
// node, everything else is a block holding its own markup, and the head is kept whole. Nothing is fetched and
// nothing is cleaned: the app shows this content only inside a sandboxed frame.

type Add = Extract<CommitInput["changes"][number], { op: "add" }>;

// parse5's tree, as far as it is read here.
interface Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
}
const inner = (node: Node) => serialize(node as unknown as DefaultTreeAdapterTypes.ParentNode);
const outer = (node: Node) => serializeOuter(node as unknown as DefaultTreeAdapterTypes.Node);

/** Tags that only hold other blocks: these become nodes, so the wrappers of a page survive with their classes. */
const GROUPS = new Set(["div", "main", "section", "article", "header", "footer", "aside", "nav"]);
/** What may sit inside a group for it to stay a group. Anything else (a span, loose text) makes it one block. */
const BLOCKS = new Set([
  ...GROUPS,
  ...["address", "audio", "blockquote", "canvas", "details", "dialog", "dl", "fieldset", "figure", "form"],
  ...["h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "hr", "iframe", "img", "link", "noscript", "ol", "p", "picture"],
  ...["pre", "script", "style", "svg", "table", "template", "ul", "video"],
]);
const MAX_DEPTH = 12;

const isText = (node: Node) => node.nodeName === "#text";
const isBlank = (node: Node) => isText(node) && (node.value ?? "").trim() === "";
const isElement = (node: Node) => !node.nodeName.startsWith("#");
// Attributes stay a list, in the order the file has them: a map would be sorted when it is stored.
const attrsOf = (node: Node | undefined) => (node?.attrs ?? []).map((a): [string, string] => [a.name, a.value]);
const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const find = (node: Node | undefined, tag: string) => node?.childNodes?.find((child) => child.nodeName === tag);

function isGroup(node: Node, depth: number): boolean {
  const children = (node.childNodes ?? []).filter((child) => child.nodeName !== "#comment" && !isBlank(child));
  return (
    depth < MAX_DEPTH &&
    GROUPS.has(node.nodeName) &&
    children.length > 0 &&
    children.every((child) => isElement(child) && BLOCKS.has(child.nodeName))
  );
}

/** The changes that build an HTML file as a new Draft, and the title the file gives itself. */
export function importHtml(source: string): { title: string | undefined; changes: Add[] } {
  const root = find(parse(source) as unknown as Node, "html"),
    head = find(root, "head"),
    body = find(root, "body"),
    changes: Add[] = [];
  const add = (element: ElementDraft, parentId: string | null) => {
    const tempId = "new:" + changes.length;
    changes.push({ op: "add", tempId, parentId, element });
    return tempId;
  };
  add(
    {
      type: "html_head",
      props: { htmlAttrs: attrsOf(root), bodyAttrs: attrsOf(body) },
      html: head ? inner(head) : "",
    },
    null,
  );
  const walk = (nodes: Node[], parentId: string | null, depth: number) => {
    for (const node of nodes) {
      if (node.nodeName === "#comment" || isBlank(node)) continue;
      // Loose words in the body: a block has to be an element, so they get the plainest one.
      if (isText(node))
        add({ type: "html_block", props: {}, html: `<span>${escapeText(node.value ?? "")}</span>` }, parentId);
      else if (isGroup(node, depth))
        walk(
          node.childNodes ?? [],
          add({ type: "html_node", props: { tag: node.nodeName, attrs: attrsOf(node) } }, parentId),
          depth + 1,
        );
      else if (isElement(node)) add({ type: "html_block", props: {}, html: outer(node) }, parentId);
    }
  };
  walk(body?.childNodes ?? [], null, 0);
  const named = find(head, "title"),
    title = named ? htmlPlainText(inner(named)) : "";
  return { title: title || undefined, changes };
}
