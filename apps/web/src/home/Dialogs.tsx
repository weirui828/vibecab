import { useEffect, useRef, useState } from "react";
import { Button, Field, Icon, Input } from "@wei/design-system";
import { terms } from "../copy/terms.js";
import { Dialog } from "../ui/Dialog.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import type { NewDraft } from "./actions.js";

const NEW_SESSION = "__new__";

export function NewDraftDialog({
  open,
  sessions,
  fixedSession,
  onClose,
  onCreate,
}: {
  open: boolean;
  sessions: SessionRow[];
  /** Adding to a known session: no session picker. */
  fixedSession?: SessionRow;
  onClose(): void;
  onCreate(draft: NewDraft): Promise<boolean>;
}) {
  const [empty, setEmpty] = useState(false),
    [title, setTitle] = useState(""),
    [file, setFile] = useState<{ name: string; text: string }>(),
    [over, setOver] = useState(false),
    [sessionId, setSessionId] = useState(NEW_SESSION),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ on: "file" | "title"; text: string }>(),
    chooser = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setEmpty(false);
    setTitle("");
    setFile(undefined);
    setOver(false);
    setSessionId(NEW_SESSION);
    setError(undefined);
  }, [open]);
  const active = sessions.filter((s) => s.state === "active"),
    isHtml = file !== undefined && /\.html?$/i.test(file.name),
    fromName = file?.name.replace(/\.(md|markdown|txt|html?)$/i, "") ?? "";
  const take = (chosen: File | undefined) => {
    if (!chosen) return;
    setError(undefined);
    setEmpty(false);
    void chosen.text().then((text) => setFile({ name: chosen.name, text }));
  };
  async function submit() {
    if (!empty && !file) return setError({ on: "file", text: "Choose a file, or start with an empty page." });
    const name = title.trim() || (empty ? "" : fromName);
    if (!name) return setError({ on: "title", text: "Give it a title." });
    setBusy(true);
    const target = fixedSession ?? sessions.find((s) => s.sessionId === sessionId);
    const ok = await onCreate({
      title: name,
      role: target && target.artifactIds.length > 0 ? "reference" : "primary",
      ...(!empty && file ? (isHtml ? { html: file.text } : { markdown: file.text }) : {}),
      ...(fixedSession ? { sessionId: fixedSession.sessionId } : sessionId !== NEW_SESSION ? { sessionId } : {}),
      ...(fixedSession?.state === "paused" ? { resume: true } : {}),
    });
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog
      open={open}
      title={fixedSession ? `Add a ${terms.draft.toLowerCase()}` : `New ${terms.draft.toLowerCase()}`}
      lede={
        fixedSession
          ? `To “${fixedSession.title}”${fixedSession.state === "paused" ? `, which resumes` : ""}. From a file on this computer.`
          : "From a file on this computer."
      }
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
      {/* The file is the way in, so it is the largest thing here: drop one on it, or press the button. */}
      <div
        className="vc-drop"
        data-over={over || undefined}
        data-filled={file !== undefined || undefined}
        data-off={empty || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          take(event.dataTransfer.files[0]);
        }}
      >
        <input
          ref={chooser}
          className="sr-only"
          type="file"
          aria-label="File"
          tabIndex={-1}
          accept=".md,.markdown,.txt,.html,.htm,text/markdown,text/plain,text/html"
          onChange={(event) => take(event.target.files?.[0])}
        />
        <Icon name={file ? "document-text" : "arrow-up-tray"} size={24} />
        {file ? (
          <>
            <strong>{file.name}</strong>
            <span>
              {isHtml
                ? "HTML. It is kept as it is, and shown in a closed frame with no network."
                : "Markdown or plain text."}
            </span>
          </>
        ) : (
          <>
            <strong>Drop a file here</strong>
            <span>Markdown, plain text or HTML</span>
          </>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => chooser.current?.click()}>
          {file ? "Choose another file" : "Choose a file"}
        </Button>
        {error?.on === "file" && (
          <p className="vc-drop-error" role="alert">
            {error.text}
          </p>
        )}
      </div>
      <label className="vc-empty-start">
        <input
          type="checkbox"
          checked={empty}
          onChange={(event) => {
            setEmpty(event.target.checked);
            setError(undefined);
          }}
        />
        <span>
          Start with an empty page
          <small>No file: ask the agent in a comment to write the first version.</small>
        </span>
      </label>
      <Field label="Title" error={error?.on === "title" ? error.text : undefined}>
        <Input
          inputSize="lg"
          autoFocus
          value={title}
          placeholder={!empty && fromName ? fromName : "Untitled"}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(undefined);
          }}
        />
      </Field>
      {!fixedSession && active.length > 0 && (
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

export function AttachDialog({
  open,
  session,
  drafts,
  onClose,
  onAttach,
}: {
  open: boolean;
  session: SessionRow | undefined;
  drafts: DraftRow[];
  onClose(): void;
  onAttach(artifactId: string): Promise<boolean>;
}) {
  const candidates = drafts.filter((d) => !session?.artifactIds.includes(d.artifactId)),
    [choice, setChoice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setChoice(candidates[0]?.artifactId ?? "");
  }, [open]);
  async function submit() {
    if (!choice) return;
    setBusy(true);
    const ok = await onAttach(choice);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog
      open={open}
      title={`Add an existing ${terms.draft.toLowerCase()}`}
      lede={
        session
          ? `It stays where it is and also joins “${session.title}”${session.state === "paused" ? ", which resumes" : ""}.`
          : undefined
      }
      onClose={onClose}
      onSubmit={() => void submit()}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!choice}>
            Add
          </Button>
        </>
      }
    >
      {candidates.length ? (
        <Field label={terms.draft}>
          <select className="vc-select" value={choice} onChange={(event) => setChoice(event.target.value)}>
            {candidates.map((d) => (
              <option key={d.artifactId} value={d.artifactId}>
                {d.title}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="vc-muted" style={{ margin: 0 }}>
          Every {terms.draft.toLowerCase()} is already here.
        </p>
      )}
    </Dialog>
  );
}
