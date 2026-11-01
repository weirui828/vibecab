import type { ReactNode } from "react";
import type { Element } from "../../../../contract/generated/index.js";

/** Whole-session composer plus the floating button shown next to a text selection. */
export function CommentDock({
  selected,
  float,
  composer,
  onFloatClick,
}: {
  selected?: { element: Element; locator?: { quote: string; prefix: string; suffix: string } };
  float?: { left: number; top: number };
  composer?: ReactNode;
  onFloatClick: () => void;
}) {
  return (
    <>
      {composer}
      {float && selected ? (
        <button
          type="button"
          className="comment-float"
          style={{ left: float.left, top: float.top }}
          onClick={() => {
            onFloatClick();
            document.querySelector<HTMLTextAreaElement>(".doc-comment-slot textarea, .comment-form textarea")?.focus();
          }}
        >
          Comment
        </button>
      ) : null}
    </>
  );
}
