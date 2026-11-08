// Mapping between a text element's plain text (what anchors count in) and the DOM that renders it.
// Each text element renders its inline content inside `[data-text-for="<elementId>"]`, whose textContent equals
// `inlineMarkdownToPlainText(element.text)`.

export interface TextSelection {
  elementId: string;
  start: number;
  end: number;
}

const ELEMENT_NODE = 1,
  SHOW_TEXT = 4; // Node.ELEMENT_NODE, NodeFilter.SHOW_TEXT, without depending on the window's globals

function textContainer(node: Node | null): HTMLElement | undefined {
  const element = node?.nodeType === ELEMENT_NODE ? (node as globalThis.Element) : node?.parentElement;
  return element?.closest<HTMLElement>("[data-text-for]") ?? undefined;
}

/** Characters of `container`'s text before (`node`, `offset`). */
function offsetIn(container: HTMLElement, node: Node, offset: number): number {
  const range = container.ownerDocument.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * The part of a DOM range that falls in its first text element, as plain-text offsets. A selection across several
 * elements anchors to the first one and quotes only its part. Returns undefined for empty or non-text selections.
 */
export function selectionInElement(range: Range): TextSelection | undefined {
  const first = textContainer(range.startContainer);
  if (!first) return undefined;
  const elementId = first.dataset.textFor;
  if (!elementId) return undefined;
  const start = offsetIn(first, range.startContainer, range.startOffset);
  const end = first.contains(range.endContainer)
    ? offsetIn(first, range.endContainer, range.endOffset)
    : (first.textContent ?? "").length;
  return end > start ? { elementId, start, end } : undefined;
}

/** A DOM range covering plain-text offsets [start, end) inside `container`, for highlighting. */
export function rangeForOffsets(container: HTMLElement, start: number, end: number): Range | undefined {
  const doc = container.ownerDocument,
    walker = doc.createTreeWalker(container, SHOW_TEXT);
  const range = doc.createRange();
  let seen = 0,
    started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= seen + length) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return undefined;
}

export function textContainerFor(root: ParentNode, elementId: string): HTMLElement | undefined {
  return root.querySelector<HTMLElement>(`[data-text-for="${elementId.replace(/["\\]/g, "\\$&")}"]`) ?? undefined;
}

/** `[data-element-id="…"]` with the value quoted for a selector (ids are opaque strings). */
export function byElementId(elementId: string): string {
  return `[data-element-id="${elementId.replace(/["\\]/g, "\\$&")}"]`;
}

/** A range's box; zero-sized where layout is unavailable (tests). */
export function rectOf(range: Range): { top: number; left: number; width: number } {
  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : { top: 0, left: 0, width: 0 };
}
