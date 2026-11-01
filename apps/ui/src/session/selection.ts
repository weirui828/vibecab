import { useEffect, useState } from "react";
import type { Element } from "../../../../contract/generated/index.js";
import { inlineMarkdownToPlainText } from "../../../../contract/src/inline-markdown.js";
import { locatorForTextSelection } from "../document/anchors.js";
import type { Selected } from "./types.js";

const floatWidth = 88;

/**
 * Tracks the piece (or text range) a comment should attach to and the floating "Comment"
 * button shown next to a text selection. The engine owns validation; this only resolves the
 * DOM selection into a schema-shaped anchor candidate.
 */
export function useCommentSelection(elements: Element[], onClear: () => void) {
  const [selected, setSelected] = useState<Selected>();
  const [float, setFloat] = useState<{ left: number; top: number }>();
  useEffect(() => {
    if (!float) return;
    // A floating "Comment" button anchored to a stale rectangle is worse than none.
    const dismiss = () => setFloat(undefined);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [float]);
  const chooseRange = () => {
    const selection = window.getSelection(),
      selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : undefined,
      textNode = selectionRange?.startContainer,
      el = textNode instanceof globalThis.Element ? textNode : textNode?.parentElement?.closest("[data-element-id]");
    if (!selection || !selectionRange || !el) return;
    const element = elements.find((candidate) => candidate.elementId === el.getAttribute("data-element-id"));
    if (!element || !("text" in element)) return;
    const contents = document.createRange();
    contents.selectNodeContents(el);
    const clipped = selectionRange.cloneRange();
    if (clipped.compareBoundaryPoints(Range.END_TO_END, contents) > 0)
      clipped.setEnd(contents.endContainer, contents.endOffset);
    const startRange = document.createRange();
    startRange.selectNodeContents(el);
    startRange.setEnd(clipped.startContainer, clipped.startOffset);
    const start = Math.max(0, inlineMarkdownToPlainText(startRange.toString()).length),
      quote = clipped.toString();
    if (!quote) {
      setFloat(undefined);
      return;
    }
    setSelected({
      element,
      locator: locatorForTextSelection(element.text, start, start + quote.length),
      source: "range",
    });
    const rect = clipped.getBoundingClientRect();
    setFloat({
      left: Math.min(
        Math.max(8, rect.left + rect.width / 2 - floatWidth / 2),
        Math.max(8, window.innerWidth - floatWidth - 8),
      ),
      top: Math.max(8, rect.top - 6),
    });
  };
  const clearSelection = () => {
    setSelected(undefined);
    setFloat(undefined);
    onClear();
  };
  return { selected, float, setSelected, chooseRange, clearSelection, dismissFloat: () => setFloat(undefined) };
}
