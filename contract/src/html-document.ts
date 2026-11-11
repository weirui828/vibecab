import type { Element } from "../generated/index.js";

// An HTML Draft written out again from its elements. Plain string work, with no parser: the engine uses it to
// export, and the web app to fill the frame a Draft is shown in.

const escapeAttr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const attributes = (attrs: Array<[string, string]>) =>
  attrs.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");

/** What is inside `<body>`: the tree in order, each block as it is stored. `mark` may add to a block's first tag. */
export function htmlBody(elements: Element[], mark?: (element: Element) => string): string {
  const children = (parentId: string | null) =>
    elements
      .filter((e) => e.parentId === parentId && e.type !== "html_head")
      .sort((a, b) => (a.order < b.order ? -1 : 1));
  const render = (element: Element): string => {
    const extra = mark?.(element) ?? "";
    if (element.type === "html_node")
      return `<${element.props.tag}${attributes(element.props.attrs)}${extra}>\n${children(element.elementId).map(render).join("\n")}\n</${element.props.tag}>`;
    if (element.type !== "html_block") return "";
    // The block is one element (the contract checks it), so its first tag ends at the first space, slash or bracket.
    return extra ? element.html.replace(/^<[^\s/>]+/, (open) => open + extra) : element.html;
  };
  return children(null).map(render).join("\n");
}

/** The whole file again, from its elements. */
export function htmlDocument(elements: Element[], mark?: (element: Element) => string, headFirst = ""): string {
  const head = elements.find((e) => e.type === "html_head"),
    props = head?.type === "html_head" ? head.props : { htmlAttrs: [], bodyAttrs: [] };
  return [
    `<!DOCTYPE html><html${attributes(props.htmlAttrs)}><head>${headFirst}${head?.type === "html_head" ? head.html : ""}</head>`,
    `<body${attributes(props.bodyAttrs)}>`,
    htmlBody(elements, mark),
    "</body></html>",
  ].join("\n");
}
