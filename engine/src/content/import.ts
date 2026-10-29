import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes, Root } from "mdast";
import type { CommitInput, ElementDraft } from "../../../contract/src/index.js";
type Add = Extract<
  CommitInput["changes"][number],
  {
    op: "add";
  }
>;
export function escapeInline(text: string): string {
  return text.replace(/[\\`*[\]<>!_~]/g, "\\$&").replace(/^(\s*)(#{1,6}|[-+]|\d+[.)])(?=\s)/gm, "$1\\$2");
}
function plain(node: Nodes): string {
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  return "children" in node ? node.children.map(plain).join("") : "";
}
function inline(node: Nodes, root: Root): string {
  const inner = () => ("children" in node ? node.children.map((n) => inline(n, root)).join("") : "");
  switch (node.type) {
    case "text":
      return escapeInline(node.value);
    case "strong":
      return "**" + inner() + "**";
    case "emphasis":
      return "*" + inner() + "*";
    case "inlineCode":
      return node.value.includes("`") ? escapeInline(node.value) : "`" + node.value + "`";
    case "link":
    case "image":
      return (
        "[" +
        (node.type === "image" ? escapeInline(node.alt ?? "") : inner()) +
        "](" +
        node.url.replace(/[\s()<>]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c))) +
        ")"
      );
    case "linkReference":
    case "imageReference": {
      const definition = root.children.find((n) => n.type === "definition" && n.identifier === node.identifier);
      if (definition?.type === "definition")
        return (
          "[" +
          (node.type === "imageReference" ? escapeInline(node.alt ?? "") : inner()) +
          "](" +
          definition.url.replace(/[\s()<>]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c))) +
          ")"
        );
      return escapeInline(plain(node));
    }
    case "break":
      return "\n";
    case "delete":
      return escapeInline(plain(node));
    case "html":
      return escapeInline(node.value);
    default:
      return "children" in node ? inner() : escapeInline(plain(node));
  }
}
export function importContent(content: string, format: "markdown" | "text"): Add[] {
  const changes: Add[] = [];
  const add = (element: ElementDraft, parentId: string | null) => {
    const tempId = "new:" + changes.length;
    changes.push({ op: "add", tempId, parentId, element });
    return tempId;
  };
  if (format === "text") {
    for (const block of content.split(/\r?\n\s*\r?\n/).filter((b) => b.trim()))
      add({ type: "paragraph", props: {}, text: escapeInline(block) }, null);
    return changes;
  }
  const root = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const text = (node: Nodes) =>
    "children" in node ? node.children.map((n) => inline(n, root)).join("") : inline(node, root);
  const blocks = (nodes: Nodes[], parentId: string | null) => {
    for (const node of nodes) {
      switch (node.type) {
        case "definition":
          break;
        case "heading":
          add({ type: "heading", props: { level: node.depth }, text: text(node) }, parentId);
          break;
        case "paragraph":
          add({ type: "paragraph", props: {}, text: text(node) }, parentId);
          break;
        case "blockquote":
          add(
            {
              type: "quote",
              props: {},
              text: node.children.map(text).join("\n"),
            },
            parentId,
          );
          break;
        case "code":
          add(
            {
              type: "code_block",
              props: node.lang ? { language: node.lang } : {},
              text: node.value,
            },
            parentId,
          );
          break;
        case "thematicBreak":
          add({ type: "divider", props: {} }, parentId);
          break;
        case "list": {
          const listId = add({ type: "list", props: { ordered: node.ordered ?? false } }, parentId);
          for (const item of node.children) {
            const itemId = add(
              {
                type: "list_item",
                props: {},
                text: item.children
                  .filter((n) => n.type !== "list")
                  .map(text)
                  .join("\n\n"),
              },
              listId,
            );
            blocks(
              item.children.filter((n) => n.type === "list"),
              itemId,
            );
          }
          break;
        }
        case "table": {
          const table = add({ type: "table", props: { headerRow: true } }, parentId);
          for (const row of node.children) {
            const rowId = add({ type: "table_row", props: {} }, table);
            for (const cell of row.children) add({ type: "table_cell", props: {}, text: text(cell) }, rowId);
          }
          break;
        }
        default: {
          const value = text(node);
          if (value) add({ type: "paragraph", props: {}, text: value }, parentId);
        }
      }
    }
  };
  blocks(root.children, null);
  return changes;
}
// A test/export helper over drafts; it is never an additional adapter entry point.
export function outlineMarkdown(nodes: Add[]): string {
  const children = (id: string | null) => nodes.filter((n) => n.parentId === id);
  const render = (node: Add, depth = 0): string => {
    const e = node.element,
      nested = children(node.tempId);
    switch (e.type) {
      case "heading":
        return "#".repeat(e.props.level) + " " + e.text;
      case "paragraph":
        return e.text;
      case "quote":
        return e.text
          .split("\n")
          .map((t) => "> " + t)
          .join("\n");
      case "code_block": {
        const fence = "`".repeat(Math.max(3, ...[...e.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
        return fence + (e.props.language ?? "") + "\n" + e.text + "\n" + fence;
      }
      case "divider":
        return "---";
      case "list":
        return nested
          .map(
            (item, i) =>
              "  ".repeat(depth) +
              (e.props.ordered ? String(i + 1) + ". " : "- ") +
              (item.element.type === "list_item" ? item.element.text : "") +
              children(item.tempId)
                .map((n) => "\n" + render(n, depth + 1))
                .join(""),
          )
          .join("\n");
      case "table": {
        const rows = nested.map(
          (row) =>
            "| " +
            children(row.tempId)
              .map((c) => (c.element.type === "table_cell" ? c.element.text.replaceAll("|", "\\|") : ""))
              .join(" | ") +
            " |",
        );
        if (e.props.headerRow && rows.length)
          rows.splice(
            1,
            0,
            "| " +
              children(nested[0]!.tempId)
                .map(() => "---")
                .join(" | ") +
              " |",
          );
        return rows.join("\n");
      }
      default:
        return "text" in e ? e.text : "";
    }
  };
  return children(null)
    .map((n) => render(n))
    .join("\n\n");
}
