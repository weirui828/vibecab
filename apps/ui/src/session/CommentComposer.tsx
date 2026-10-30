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
        <label>
          Comment
          <textarea aria-label="Comment" value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        {selected ? (
          <label>
            Suggest replacement
            <input
              value={suggestion}
              onChange={(event) => setSuggestion(event.target.value)}
              placeholder={selected.locator?.quote ?? "Optional"}
            />
          </label>
        ) : null}
        <button type="submit">Post comment</button>
      </form>
    </>
  );
}
