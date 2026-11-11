import type { Element } from "../../../contract/src/index.js";
import { htmlPlainText } from "../../../contract/src/index.js";
import { htmlBody } from "../content/index.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inlineHtml(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(elements: Element[]): string {
  const children = (parentId: string | null) => elements.filter((element) => element.parentId === parentId);
  const render = (element: Element, depth = 0): string => {
    const nested = children(element.elementId);
    switch (element.type) {
      // An HTML Draft has no Markdown form: its blocks are given as the words a reader sees.
      case "html_head":
      case "html_node":
        return nested
          .map((child) => render(child, depth))
          .filter(Boolean)
          .join("\n\n");
      case "html_block":
        return htmlPlainText(element.html);
      case "heading":
        return "#".repeat(element.props.level) + " " + element.text;
      case "paragraph":
        return element.text;
      case "quote":
        return element.text
          .split("\n")
          .map((line) => "> " + line)
          .join("\n");
      case "code_block": {
        const fence = "`".repeat(Math.max(3, ...[...element.text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        return `${fence}${element.props.language ?? ""}\n${element.text}\n${fence}`;
      }
      case "divider":
        return "---";
      case "list":
        return nested
          .map((item, index) => {
            const prefix = "  ".repeat(depth) + (element.props.ordered ? `${index + 1}. ` : "- ");
            return (
              prefix +
              (item.type === "list_item" ? item.text : "") +
              children(item.elementId)
                .map((child) => "\n" + render(child, depth + 1))
                .join("")
            );
          })
          .join("\n");
      case "table": {
        const rows = nested.map(
          (row) =>
            "| " +
            children(row.elementId)
              .map((cell) => (cell.type === "table_cell" ? cell.text.replaceAll("|", "\\|") : ""))
              .join(" | ") +
            " |",
        );
        if (element.props.headerRow && rows.length) {
          const cellCount = nested[0] ? children(nested[0].elementId).length : 0;
          rows.splice(1, 0, "| " + Array.from({ length: cellCount }, () => "---").join(" | ") + " |");
        }
        return rows.join("\n");
      }
      case "callout":
        return `> **${element.props.tone.toUpperCase()}**\n> ${element.text.replaceAll("\n", "\n> ")}`;
      case "image":
        return `![${element.props.alt ?? ""}](blob:${element.blobHash})`;
      case "list_item":
      case "table_row":
      case "table_cell":
        return "text" in element ? element.text : "";
    }
  };
  return children(null)
    .map((element) => render(element))
    .join("\n\n");
}

function renderHtmlBlock(element: Element, children: string[], imageSources: Map<string, string>): string {
  switch (element.type) {
    // Among other documents an HTML Draft gives its body; alone, it is exported as its own file (see the export job).
    case "html_head":
      return "";
    case "html_node":
    case "html_block":
      return htmlBody([{ ...element, parentId: null }]);
    case "heading":
      return `<h${element.props.level}>${inlineHtml(element.text)}</h${element.props.level}>`;
    case "paragraph":
      return `<p>${inlineHtml(element.text)}</p>`;
    case "quote":
      return `<blockquote>${element.text.split("\n").map(inlineHtml).join("<br>")}</blockquote>`;
    case "code_block":
      return `<pre><code>${escapeHtml(element.text)}</code></pre>`;
    case "divider":
      return "<hr>";
    case "list":
      return `<${element.props.ordered ? "ol" : "ul"}>${children.join("")}</${element.props.ordered ? "ol" : "ul"}>`;
    case "list_item":
      return `<li>${inlineHtml(element.text)}${children.join("")}</li>`;
    case "table":
      return `<table>${children.join("")}</table>`;
    case "table_row":
      return `<tr>${children.join("")}</tr>`;
    case "table_cell":
      return `<td>${inlineHtml(element.text)}</td>`;
    case "image":
      return `<figure><img src="${imageSources.get(element.blobHash) ?? `blob:${element.blobHash}`}" alt="${escapeHtml(element.props.alt ?? "")}">${
        element.props.caption ? `<figcaption>${inlineHtml(element.props.caption)}</figcaption>` : ""
      }</figure>`;
    case "callout":
      return `<aside class="${element.props.tone}">${inlineHtml(element.text)}</aside>`;
  }
}

export function renderHtmlFragment(elements: Element[], imageSources = new Map<string, string>()): string {
  const children = (parentId: string | null) => elements.filter((element) => element.parentId === parentId);
  const render = (element: Element): string =>
    renderHtmlBlock(element, children(element.elementId).map(render), imageSources);
  return children(null).map(render).join("\n");
}

export function renderHtml(elements: Element[], imageSources = new Map<string, string>()): string {
  return renderHtmlDocument(renderHtmlFragment(elements, imageSources));
}

export function renderHtmlDocument(body: string): string {
  const style = [
    "body{font:16px/1.6 system-ui,sans-serif;max-width:72ch;margin:3rem auto;padding:0 1rem}",
    "pre{overflow:auto;background:#f4f4f4;padding:1rem}",
    "blockquote,aside{border-left:3px solid #999;padding:.25rem 1rem;color:#444}",
    "aside.warning{border-color:#b33;background:#fff3f3}",
    "table{border-collapse:collapse}",
    "td,th{border:1px solid #bbb;padding:.4rem .7rem}",
    "img{max-width:100%}",
  ].join("");
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width">',
    `<style>${style}</style></head><body>${body}</body></html>`,
  ].join("");
}
