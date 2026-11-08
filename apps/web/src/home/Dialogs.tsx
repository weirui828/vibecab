import { useEffect, useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { Dialog } from "../ui/Dialog.js";
import type { SessionRow } from "../live/workspace.js";
import type { NewDraft } from "./actions.js";

const NEW_SESSION = "__new__";

export function NewDraftDialog({
  open,
  sessions,
  onClose,
  onCreate,
}: {
  open: boolean;
  sessions: SessionRow[];
  onClose(): void;
  onCreate(draft: NewDraft): Promise<boolean>;
}) {
  const [mode, setMode] = useState<"blank" | "import">("blank"),
    [title, setTitle] = useState(""),
    [file, setFile] = useState<{ name: string; text: string }>(),
    [sessionId, setSessionId] = useState(NEW_SESSION),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setMode("blank");
    setTitle("");
    setFile(undefined);
    setSessionId(NEW_SESSION);
    setError(undefined);
  }, [open]);
  const active = sessions.filter((s) => s.state === "active");
  async function submit() {
    const name = title.trim() || file?.name.replace(/\.(md|markdown|txt)$/i, "") || "";
    if (!name) return setError("Give it a title.");
    if (mode === "import" && !file) return setError("Choose a Markdown file.");
    setBusy(true);
    const ok = await onCreate({
      title: name,
      ...(mode === "import" && file ? { markdown: file.text } : {}),
      ...(sessionId !== NEW_SESSION ? { sessionId } : {}),
    });
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog
      open={open}
      title={`New ${terms.draft.toLowerCase()}`}
      lede="Start from a blank page or bring in a Markdown file."
      onClose={onClose}
      onSubmit={() => void submit()}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <div className="vc-choice" role="radiogroup" aria-label="Start from">
        <label>
          <input type="radio" name="mode" checked={mode === "blank"} onChange={() => setMode("blank")} />
          <strong>Blank {terms.document.toLowerCase()}</strong>
          <span>An empty page to comment on with the agent.</span>
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === "import"} onChange={() => setMode("import")} />
          <strong>Import Markdown</strong>
          <span>A .md or .txt file from this computer.</span>
        </label>
      </div>
      {mode === "import" && (
        <Field label="File">
          <input
            className="vc-file"
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (!chosen) return setFile(undefined);
              void chosen.text().then((text) => setFile({ name: chosen.name, text }));
            }}
          />
        </Field>
      )}
      <Field label="Title" error={error}>
        <Input
          inputSize="lg"
          autoFocus
          value={title}
          placeholder={mode === "import" && file ? file.name.replace(/\.(md|markdown|txt)$/i, "") : "Untitled"}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(undefined);
          }}
        />
      </Field>
      {active.length > 0 && (
        <Field label={terms.session}>
          <select className="vc-select" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
            <option value={NEW_SESSION}>A new {terms.session.toLowerCase()}</option>
            {active.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Dialog>
  );
}

export function TitleDialog({
  open,
  title,
  lede,
  initial = "",
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  lede?: string;
  initial?: string;
  submitLabel: string;
  onClose(): void;
  onSubmit(value: string): Promise<boolean>;
}) {
  const [value, setValue] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(undefined);
    }
  }, [open, initial]);
  async function submit() {
    if (!value.trim()) return setError("Give it a title.");
    setBusy(true);
    const ok = await onSubmit(value.trim());
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog
      open={open}
      title={title}
      {...(lede ? { lede } : {})}
      onClose={onClose}
      onSubmit={() => void submit()}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <Field label="Title" error={error}>
        <Input
          inputSize="lg"
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
        />
      </Field>
    </Dialog>
  );
}
