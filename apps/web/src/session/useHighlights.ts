import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { inlineMarkdownToPlainText, locateQuote } from "../../../../contract/src/inline-markdown.js";
import type { Element } from "../../../../contract/generated/index.js";
import { anchorOf, resolutionOf } from "./threads.js";
import type { Thread } from "./threads.js";
import { byElementId, rangeForOffsets, textContainerFor } from "./textRanges.js";

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}
declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

function registry(): HighlightRegistry | undefined {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined;
  return typeof Highlight === "undefined" ? undefined : css?.highlights;
}

/**
 * Marks each thread's place in the Document without touching the text: the CSS Custom Highlight API paints the
 * quote (`current`, or `revised` when the quote is still found); a revised block without its quote gets a tint.
 * Returns the DOM range per thread so clicks on highlighted text can find their thread.
 */
export function useHighlights(
  root: RefObject<HTMLElement | null>,
  threads: Thread[],
  elements: Element[],
  focused: string | undefined,
  /** The words being commented on right now, marked like a focused thread. */
  writing?: { elementId: string; locator?: { quote: string; prefix: string; suffix: string } },
): RefObject<Map<string, Range>> {
  const ranges = useRef(new Map<string, Range>());
  useEffect(() => {
    const container = root.current,
      reg = registry();
    if (!container) return;
    const byId = new Map(elements.map((e) => [e.elementId, e]));
    const current: Range[] = [],
      revised: Range[] = [],
      focus: Range[] = [],
      tinted: HTMLElement[] = [];
    ranges.current = new Map();
    for (const thread of threads) {
      const anchor = anchorOf(thread),
        state = resolutionOf(thread)?.state ?? "current";
      if (!anchor || state === "removed") continue;
      const element = byId.get(anchor.elementId),
        box = container.querySelector<HTMLElement>(byElementId(anchor.elementId));
      let range: Range | undefined;
      if (anchor.locator && element && "text" in element) {
        const at = locateQuote(inlineMarkdownToPlainText(element.text), anchor.locator),
          text = textContainerFor(container, anchor.elementId);
        if (at && text) range = rangeForOffsets(text, at.start, at.end);
      }
      if (range) {
        ranges.current.set(thread.threadId, range);
        (state === "revised" ? revised : current).push(range);
        if (thread.threadId === focused) focus.push(range);
      } else if (box && (state === "revised" || !anchor.locator)) {
        box.dataset.mark = state === "revised" ? "revised" : "block";
        if (thread.threadId === focused) box.dataset.markFocus = "true";
        tinted.push(box);
      }
    }
    if (writing?.locator) {
      const element = byId.get(writing.elementId),
        text = textContainerFor(container, writing.elementId),
        at =
          element && "text" in element
            ? locateQuote(inlineMarkdownToPlainText(element.text), writing.locator)
            : undefined;
      const range = at && text ? rangeForOffsets(text, at.start, at.end) : undefined;
      if (range) focus.push(range);
    }
    if (reg) {
      reg.set("vc-comment", new Highlight!(...current));
      reg.set("vc-revised", new Highlight!(...revised));
      reg.set("vc-focus", new Highlight!(...focus));
    }
    return () => {
      for (const box of tinted) {
        delete box.dataset.mark;
        delete box.dataset.markFocus;
      }
      if (reg) for (const name of ["vc-comment", "vc-revised", "vc-focus"]) reg.delete(name);
    };
  }, [root, threads, elements, focused, writing]);
  return ranges;
}
