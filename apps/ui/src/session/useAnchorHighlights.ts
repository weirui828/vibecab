import { useEffect } from "react";
import type { VcThreadsOperation } from "../../../../contract/generated/index.js";

export function useAnchorHighlights(threads: VcThreadsOperation["result"]): void {
  useEffect(() => {
    const current: Range[] = [],
      revised: Range[] = [];
    for (const thread of threads)
      for (const resolution of thread.anchorResolutions) {
        if (resolution.state === "removed") continue;
        const node = document.querySelector(`[data-element-id="${CSS.escape(resolution.anchor.elementId)}"]`);
        if (!node) continue;
        const range = document.createRange();
        if (resolution.state === "revised") {
          range.selectNodeContents(node);
          revised.push(range);
          continue;
        }
        const quote = resolution.anchor.locator?.quote;
        if (!quote) continue;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT),
          textNodes: Text[] = [];
        let nextNode = walker.nextNode();
        while (nextNode) {
          if (nextNode instanceof Text) textNodes.push(nextNode);
          nextNode = walker.nextNode();
        }
        const start = textNodes
          .map((textNode) => textNode.data)
          .join("")
          .indexOf(quote);
        if (start < 0) continue;
        let cursor = 0,
          startNode: Text | undefined,
          endNode: Text | undefined,
          startOffset = 0,
          endOffset = 0;
        for (const textNode of textNodes) {
          const end = cursor + textNode.data.length;
          if (!startNode && start >= cursor && start < end) {
            startNode = textNode;
            startOffset = start - cursor;
          }
          if (start + quote.length >= cursor && start + quote.length <= end) {
            endNode = textNode;
            endOffset = start + quote.length - cursor;
            break;
          }
          cursor = end;
        }
        if (startNode && endNode) {
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);
          current.push(range);
        }
      }
    if (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined") {
      CSS.highlights.delete("vibecab-current");
      CSS.highlights.delete("vibecab-revised");
      if (current.length) CSS.highlights.set("vibecab-current", new Highlight(...current));
      if (revised.length) CSS.highlights.set("vibecab-revised", new Highlight(...revised));
    }
    return () => {
      if (typeof CSS !== "undefined" && "highlights" in CSS) {
        CSS.highlights.delete("vibecab-current");
        CSS.highlights.delete("vibecab-revised");
      }
    };
  }, [threads]);
}
