import { useEffect } from "react";
import type { RefObject } from "react";
import { byElementId } from "./textRanges.js";

/**
 * As in covibe: the block under the pointer gets a dashed outline (what a comment would be about), and the block
 * being commented on keeps a solid one while the comment is written. Marked on the DOM, so the Document never
 * re-renders for a pointer move.
 */
export function useBlockOutline(
  root: RefObject<HTMLElement | null>,
  hovered: string | undefined,
  commenting: string | undefined,
  elements: unknown,
) {
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const mark = (id: string | undefined, attr: string) => {
      const block = id ? node.querySelector<HTMLElement>(byElementId(id)) : null;
      block?.setAttribute(attr, "");
      return () => block?.removeAttribute(attr);
    };
    const unhover = mark(hovered, "data-target"),
      uncomment = mark(commenting, "data-commenting");
    return () => {
      unhover();
      uncomment();
    };
  }, [root, hovered, commenting, elements]);
}
