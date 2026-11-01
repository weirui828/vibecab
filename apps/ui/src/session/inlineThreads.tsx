import type { ReactNode } from "react";
import type { Element, VcThreadsOperation } from "../../../../contract/generated/index.js";

export type Thread = VcThreadsOperation["result"][number];

/**
 * Locality: every thread anchored to a live element is also rendered under the top-level block
 * that contains that element. The rail keeps the full list; inline copies sit beside the text.
 */
export function groupInlineThreads(
  threads: VcThreadsOperation["result"],
  elements: Element[],
  renderCard: (thread: Thread) => ReactNode,
): { annotations: Record<string, ReactNode> } {
  const groups = new Map<string, ReactNode[]>();
  for (const thread of threads) {
    const elementId = thread.comments.find((comment) => comment.anchor)?.anchor?.elementId,
      removed = thread.anchorResolutions.some((resolution) => resolution.state === "removed"),
      topId = elementId && !removed ? topLevelElementId(elements, elementId) : undefined;
    if (!topId) continue;
    const cards = groups.get(topId) ?? [];
    cards.push(renderCard(thread));
    groups.set(topId, cards);
  }
  const annotations = Object.fromEntries(
    [...groups].map(([elementId, cards]) => [elementId, <div className="inline-threads">{cards}</div>]),
  );
  return { annotations };
}

export function topLevelElementId(elements: Element[], elementId: string): string | undefined {
  const byId = new Map(elements.map((element) => [element.elementId, element])),
    start = byId.get(elementId);
  let current = start;
  while (current && current.parentId !== null) {
    const parent = byId.get(current.parentId);
    if (!parent) return undefined;
    current = parent;
  }
  return current?.elementId;
}
