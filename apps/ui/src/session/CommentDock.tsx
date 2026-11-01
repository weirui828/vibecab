import type { Element } from "../../../../contract/generated/index.js";
import { CommentComposer } from "./CommentComposer.js";

/** Bottom composer for whole-session comments and the floating button for a text selection. */
export function CommentDock({
  selected,
  float,
  body,
  setBody,
  suggestion,
  setSuggestion,
  replyingTo,
  onSubmit,
  onCancelReply,
  onFloatClick,
}: {
  selected?: { element: Element; locator?: { quote: string; prefix: string; suffix: string } };
  float?: { left: number; top: number };
  body: string;
  setBody: (value: string) => void;
  suggestion: string;
  setSuggestion: (value: string) => void;
  replyingTo: boolean;
  onSubmit: () => void;
  onCancelReply: () => void;
  onFloatClick: () => void;
}) {
  return (
    <>
      {selected ? null : (
        <CommentComposer
          body={body}
          setBody={setBody}
          suggestion={suggestion}
          setSuggestion={setSuggestion}
          onSubmit={onSubmit}
          replyingTo={replyingTo}
          onCancel={replyingTo ? onCancelReply : undefined}
        />
      )}
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
