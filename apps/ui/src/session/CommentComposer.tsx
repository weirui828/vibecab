import type { Element } from "../../../../contract/generated/index.js";

export function CommentComposer({
  body,
  setBody,
  selected,
  suggestion,
  setSuggestion,
  onSubmit,
  onChooseRange,
}: {
  body: string;
  setBody: (value: string) => void;
  selected?: { element: Element; locator?: { quote: string; prefix: string; suffix: string } };
  suggestion: string;
  setSuggestion: (value: string) => void;
  onSubmit: () => void;
  onChooseRange: () => void;
}) {
  return (
    <>
      <button className="comment-toolbar" onClick={onChooseRange}>
        Comment
      </button>
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
        <label>
          <span className="visually-hidden">Comment</span>
          <textarea
            aria-label="Comment"
            placeholder={selected ? "What should change here?" : "Comment on the whole session…"}
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
          <span className="meta">⌘↩ to post</span>
          <button type="submit" className="primary">
            Post comment
          </button>
        </div>
      </form>
    </>
  );
}
