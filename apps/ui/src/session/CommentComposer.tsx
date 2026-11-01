import { useEffect, useRef } from "react";
import type { Element } from "../../../../contract/generated/index.js";

export function CommentComposer({
  body,
  setBody,
  selected,
  suggestion,
  setSuggestion,
  onSubmit,
  onCancel,
  autoFocus,
  replyingTo,
}: {
  body: string;
  setBody: (value: string) => void;
  selected?: { element: Element; locator?: { quote: string; prefix: string; suffix: string } };
  suggestion: string;
  setSuggestion: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  replyingTo?: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);
  const target = selected?.element.type.replaceAll("_", " ");
  return (
    <form
      className="comment-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {selected?.locator ? (
        <p className="composer-quote">
          <q>{selected.locator.quote}</q>
        </p>
      ) : null}
      {selected && !selected.locator ? <p className="composer-target">Commenting on this {target}</p> : null}
      {replyingTo && !selected ? <p className="composer-target">Replying in this thread</p> : null}
      <label>
        <span className="visually-hidden">Comment</span>
        <textarea
          ref={textarea}
          aria-label="Comment"
          placeholder={
            selected ? "What should change here?" : replyingTo ? "Write a reply…" : "Comment on the whole session…"
          }
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {selected ? (
        <label className="suggest">
          Suggest replacement
          <input
            value={suggestion}
            onChange={(event) => setSuggestion(event.target.value)}
            placeholder={selected.locator?.quote ?? "Optional"}
          />
        </label>
      ) : null}
      <div className="composer-actions">
        {onCancel ? (
          <button type="button" className="quiet-link" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="primary">
          Post comment
        </button>
      </div>
    </form>
  );
}
