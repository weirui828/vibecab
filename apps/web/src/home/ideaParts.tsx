// Pieces shared by the Ideas, Projects and Project pages.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Field, Icon, Input, Textarea } from "@wei/design-system";
import type { Idea } from "../../../../contract/generated/index.js";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge } from "../live/LiveStore.js";
import { Dialog } from "../ui/Dialog.js";
import { useToast } from "../ui/Toast.js";
import { plural, relativeTime } from "../ui/time.js";
import { navigate } from "../shell/prefs.js";
import { newCommandId } from "../bridge/webBridge.js";
import { useActions } from "./actions.js";

export type ItemKind = "idea" | "artifact" | "session";
export const kindWords: Record<ItemKind, string> = { idea: terms.idea, artifact: terms.draft, session: terms.session };
export const ideaWord = terms.idea.toLowerCase(),
  draftWord = terms.draft.toLowerCase(),
  projectWord = terms.project.toLowerCase(),
  sessionWord = terms.session.toLowerCase();

export function useRun() {
  const bridge = useBridge(),
    toast = useToast();
  return async <T,>(type: string, payload: unknown): Promise<T | undefined> => {
    const result = await bridge.command(type, payload, newCommandId());
    if (!result.ok) {
      toast(errorMessage(result.error.code));
      return undefined;
    }
    return result.result as T;
  };
}

/** A Draft's title from ideas: the first one's words, cut at a word near 60 characters. */
export function titleFromIdeas(ideas: Array<{ text: string }>): string {
  const first = (ideas[0]?.text ?? "").replace(/\s+/g, " ").trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60),
    space = cut.lastIndexOf(" ");
  return (space > 30 ? cut.slice(0, space) : cut) + "…";
}

/** A new Draft's opening: its title as a heading, then the ideas as a list, one line each. */
export function markdownFromIdeas(ideas: Array<{ text: string }>, title?: string): string {
  const list = ideas.map((idea) => "- " + idea.text.replace(/\s+/g, " ").trim()).join("\n") + "\n";
  return title ? `# ${title.replace(/\s+/g, " ").trim()}\n\n${list}` : list;
}

/** Everything done with a set of ideas: make a Draft, gather into a Project, trash. */
export function useIdeaActions() {
  const run = useRun(),
    actions = useActions();
  return {
    run,
    /** A session about the ideas, with a Draft that starts as a list of them. */
    async makeDraft(title: string, ideas: Idea[]): Promise<boolean> {
      const ideaIds = ideas.map((i) => i.ideaId);
      const session = await run<{ sessionId: string }>("vc.StartSession", { title, ideaIds });
      if (!session) return false;
      const draft = await run<{ artifactId: string }>("vc.ImportContent", {
        title,
        format: "markdown",
        content: markdownFromIdeas(ideas, title),
      });
      if (!draft) return false;
      const attached = await run("vc.AttachArtifact", {
        sessionId: session.sessionId,
        artifactId: draft.artifactId,
        role: "primary",
      });
      if (attached === undefined) return false;
      navigate(`/s/${session.sessionId}/d/${draft.artifactId}`);
      return true;
    },
    async addToProject(projectId: string, kind: ItemKind, ids: string[]): Promise<boolean> {
      for (const id of ids)
        if ((await run("vc.AttachProjectItem", { projectId, item: { kind, id } })) === undefined) return false;
      return true;
    },
    async newProject(title: string, background: string, ideaIds: string[]): Promise<string | undefined> {
      const created = await run<{ projectId: string }>("vc.CreateProject", {
        title,
        ...(background ? { background } : {}),
        ...(ideaIds.length ? { ideaIds } : {}),
      });
      return created?.projectId;
    },
    trash(ideas: Idea[]) {
      for (const idea of ideas) void actions.trash("idea", idea.ideaId, idea.text.slice(0, 40));
    },
  };
}

/**
 * An idea's words, edited in place: click to edit, ↩ saves, ⇧↩ adds a line, Esc puts the words back.
 * Saving an unchanged or empty text changes nothing.
 */
export function IdeaText({ idea }: { idea: Idea }) {
  const run = useRun(),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(idea.text),
    field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setText(idea.text);
  }, [idea.text, editing]);
  useEffect(() => {
    const node = field.current;
    if (!editing || !node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editing]);
  const save = async () => {
    const value = text.trim();
    setEditing(false);
    if (!value || value === idea.text) return setText(idea.text);
    if (!(await run("vc.EditIdea", { ideaId: idea.ideaId, text: value }))) setText(idea.text);
  };
  if (editing)
    return (
      <textarea
        ref={field}
        className="vc-idea-edit"
        aria-label={`Edit ${ideaWord}`}
        rows={Math.min(6, Math.max(1, Math.ceil(text.length / 70)))}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setText(idea.text);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <button
      type="button"
      className="title vc-idea-text"
      title={`Edit this ${ideaWord}`}
      aria-label={`${text} — edit`}
      onClick={() => setEditing(true)}
    >
      {text}
    </button>
  );
}

/** Picks one of several things in a small dialog. */
export function PickDialog({
  open,
  title,
  lede,
  label,
  options,
  submitLabel,
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
  lede?: string;
  label: string;
  options: Array<{ id: string; title: string }>;
  submitLabel: string;
  onClose(): void;
  onPick(id: string): Promise<unknown>;
}) {
  const [choice, setChoice] = useState("");
  const value = options.some((o) => o.id === choice) ? choice : (options[0]?.id ?? "");
  return (
    <Dialog
      open={open}
      title={title}
      {...(lede ? { lede } : {})}
      onClose={onClose}
      onSubmit={() => value && void onPick(value).then((ok) => ok !== false && onClose())}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!value}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {options.length ? (
        <Field label={label}>
          <select className="vc-select" value={value} onChange={(event) => setChoice(event.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="vc-muted" style={{ margin: 0 }}>
          No {projectWord}s yet. Make one from these with New {projectWord}.
        </p>
      )}
    </Dialog>
  );
}

/** Ticks any number of things in a list, then adds them all at once. */
export function CheckDialog({
  open,
  title,
  options,
  empty,
  onClose,
  onAdd,
}: {
  open: boolean;
  title: string;
  options: Array<{ id: string; title: string; sub?: string }>;
  empty: string;
  onClose(): void;
  onAdd(ids: string[]): Promise<boolean>;
}) {
  const [picked, setPicked] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPicked([]);
      setFilter("");
    }
  }, [open]);
  const shown = options.filter((o) => o.title.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      onSubmit={async () => {
        if (!picked.length) return;
        setBusy(true);
        const ok = await onAdd(picked);
        setBusy(false);
        if (ok) onClose();
      }}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!picked.length}>
            {picked.length ? `Add ${picked.length}` : "Add"}
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="vc-muted" style={{ margin: 0 }}>
          {empty}
        </p>
      ) : (
        <>
          {options.length > 8 && (
            <Input
              inputSize="sm"
              aria-label="Filter"
              placeholder="Filter"
              prefix={<Icon name="magnifying-glass" />}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <ul className="vc-checklist">
            {shown.map((o) => (
              <li key={o.id}>
                <label>
                  <input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(o.id)} />
                  <span>
                    <span className="text">{o.title}</span>
                    {o.sub && <span className="sub">{o.sub}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

export function NewProjectDialog({
  open,
  ideas = [],
  onClose,
}: {
  open: boolean;
  /** Ideas to start the Project with. */
  ideas?: Idea[];
  onClose(): void;
}) {
  const act = useIdeaActions(),
    [title, setTitle] = useState(""),
    [background, setBackground] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle("");
      setBackground("");
    }
  }, [open]);
  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    const projectId = await act.newProject(
      title.trim(),
      background.trim(),
      ideas.map((i) => i.ideaId),
    );
    setBusy(false);
    if (projectId) {
      onClose();
      navigate("/p/" + projectId);
    }
  }
  return (
    <Dialog
      open={open}
      title={`New ${projectWord}`}
      lede={
        ideas.length
          ? `With the ${plural(ideas.length, ideaWord)} you chose.`
          : `A ${projectWord} gathers ${ideaWord}s, ${draftWord}s and ${sessionWord}s that belong together.`
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
      <Field label="Title">
        <Input inputSize="lg" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Background (optional)">
        <Textarea rows={3} value={background} onChange={(event) => setBackground(event.target.value)} />
      </Field>
    </Dialog>
  );
}

/** Make a Draft from ideas: a session about them, with a Draft that starts as their list. */
export function MakeDraftDialog({ ideas, onClose }: { ideas: Idea[] | undefined; onClose(): void }) {
  const act = useIdeaActions(),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ideas) setTitle(titleFromIdeas(ideas));
  }, [ideas]);
  return (
    <Dialog
      open={ideas !== undefined}
      title={`Make a ${draftWord}`}
      lede={`A new ${sessionWord} with a ${draftWord} that starts as ${
        (ideas?.length ?? 0) > 1 ? `a list of these ${plural(ideas?.length ?? 0, ideaWord)}` : `this ${ideaWord}`
      }.`}
      onClose={onClose}
      onSubmit={async () => {
        if (!ideas || !title.trim()) return;
        setBusy(true);
        const ok = await act.makeDraft(title.trim(), ideas);
        setBusy(false);
        if (ok) onClose();
      }}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>
            Make {draftWord}
          </Button>
        </>
      }
    >
      <Field label="Title">
        <Input inputSize="lg" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
    </Dialog>
  );
}

/** The capture field: one line, ↩ saves; the text clears at once and comes back if saving fails. */
export function Capture({ label, onSave }: { label: string; onSave(text: string): Promise<boolean> }) {
  const [text, setText] = useState("");
  return (
    <form
      className="vc-capture"
      onSubmit={async (event) => {
        event.preventDefault();
        const value = text.trim();
        if (!value) return;
        setText("");
        if (!(await onSave(value))) setText((current) => current || value);
      }}
    >
      <Input
        inputSize="lg"
        aria-label={`New ${ideaWord}`}
        placeholder={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </form>
  );
}

export function IdeaRow({
  idea,
  where,
  selected,
  onSelect,
  menu,
}: {
  idea: Idea;
  where: string;
  selected: boolean;
  onSelect(on: boolean): void;
  menu: ReactNode;
}) {
  return (
    <li className="vc-row vc-idea" data-selected={selected || undefined}>
      <span className="lead">
        <input
          type="checkbox"
          className="vc-check"
          aria-label={`Select: ${idea.text.slice(0, 60)}`}
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
        />
      </span>
      <span className="main">
        <IdeaText idea={idea} />
        <span className="sub">{where}</span>
      </span>
      <span className="end">
        <span className="when">{relativeTime(idea.createdAt)}</span>
        {menu}
      </span>
    </li>
  );
}

/** The bar of things to do with the chosen ideas; it appears once one is ticked. */
export function SelectionBar({ count, onClear, children }: { count: number; onClear(): void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="vc-selection" role="toolbar" aria-label={`Chosen ${ideaWord}s`}>
      <span className="count">{plural(count, ideaWord)}</span>
      <span className="vc-bar-sep" aria-hidden="true" />
      {children}
      <button type="button" className="clear" aria-label="Clear the choice" onClick={onClear}>
        <Icon name="x-mark" size={16} />
      </button>
    </div>
  );
}
