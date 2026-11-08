import { useState } from "react";
import { Button } from "@wei/design-system";

/** Covibe's quick marks: one click says it, with any words typed added after. */
export const quickMarks = [
  { label: "Like", body: "I like this. Keep it." },
  { label: "Dislike", body: "I don't like this." },
  { label: "Explain", body: "Explain this in more detail." },
  { label: "Delete", body: "Delete this." },
] as const;

export interface Draft {
  body: string;
  replacement?: string;
}

/** Writes a comment, a reply or an edit. The text stays if sending fails; ⌘↩ sends, Esc cancels. */
export function Composer({
  label,
  submitLabel = "Comment",
  quote,
  initial,
  allowSuggestion,
  marks = false,
  onSubmit,
  onCancel,
}: {
  /** Offer the quick marks (new comments on the Document only). */
  marks?: boolean;
  label: string;
  submitLabel?: string;
  quote?: string | undefined;
  initial?: Draft;
  allowSuggestion: boolean;
  onSubmit(draft: Draft): Promise<boolean>;
  onCancel(): void;
}) {
  const [body, setBody] = useState(initial?.body ?? ""),
    [suggest, setSuggest] = useState(initial?.replacement !== undefined),
    [replacement, setReplacement] = useState(initial?.replacement ?? quote ?? ""),
    [busy, setBusy] = useState(false);
  async function send(text = body.trim()) {
    if (!text || busy) return;
    setBusy(true);
    const ok = await onSubmit({ body: text, ...(suggest ? { replacement } : {}) });
    setBusy(false);
    if (ok) {
      setBody("");
      setSuggest(false);
    }
  }
  return (
    <form
      className="vc-composer"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void send();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      {marks && (
        <div className="vc-marks" role="group" aria-label="Quick marks">
          {quickMarks.map((mark) => (
            <button
              key={mark.label}
              type="button"
              disabled={busy}
              title={mark.body}
              onClick={() => void send(body.trim() ? `${mark.body} ${body.trim()}` : mark.body)}
            >
              {mark.label}
            </button>
          ))}
        </div>
      )}
      <textarea
        autoFocus
        rows={3}
        value={body}
        placeholder={label}
        aria-label={label}
        onChange={(event) => setBody(event.target.value)}
      />
      {allowSuggestion &&
        (suggest ? (
          <label className="vc-suggest">
            <span>Replace with</span>
            <textarea rows={2} value={replacement} onChange={(event) => setReplacement(event.target.value)} />
          </label>
        ) : (
          <button type="button" className="vc-link-button" onClick={() => setSuggest(true)}>
            Suggest a replacement
          </button>
        ))}
      <div className="row">
        <span className="vc-facts hint">⌘↩</span>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!body.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
