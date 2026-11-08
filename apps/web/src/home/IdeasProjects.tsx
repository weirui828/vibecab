import { useState } from "react";
import { Button, Field, Icon, Input, Textarea } from "@wei/design-system";
import type { Idea, Project } from "../../../../contract/generated/index.js";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { Dialog } from "../ui/Dialog.js";
import { Menu } from "../ui/Menu.js";
import { useToast } from "../ui/Toast.js";
import { plural, relativeTime } from "../ui/time.js";
import { navigate } from "../shell/prefs.js";
import { newCommandId } from "../bridge/webBridge.js";
import { useActions } from "./actions.js";
import { PageSkeleton } from "./Views.js";

type ItemKind = "idea" | "artifact" | "session";
const kindWords: Record<ItemKind, string> = { idea: terms.idea, artifact: terms.draft, session: terms.session };

function useRun() {
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

/** Picks one of several things in a small dialog. */
function PickDialog({
  open,
  title,
  label,
  options,
  submitLabel,
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
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
      onClose={onClose}
      onSubmit={() => value && void onPick(value).then(onClose)}
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
          Nothing to add yet.
        </p>
      )}
    </Dialog>
  );
}

export function IdeasView({ sessions }: { sessions: SessionRow[] }) {
  const ideas = useLiveQuery<Idea[]>("vc.Ideas", {}),
    projects = useLiveQuery<Project[]>("vc.Projects", {}),
    run = useRun(),
    actions = useActions(),
    [text, setText] = useState(""),
    [adding, setAdding] = useState<Idea>();
  const sessionTitle = new Map(sessions.map((s) => [s.sessionId, s.title])),
    projectTitle = new Map((projects.data ?? []).map((p) => [p.projectId, p.title]));
  if (ideas.loading) return <PageSkeleton />;
  const list = [...(ideas.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  async function capture() {
    const value = text.trim();
    if (!value) return;
    // Clear at once so the next idea can be typed straight away; put the text back if saving fails.
    setText("");
    if (!(await run("vc.CaptureIdea", { text: value }))) setText((current) => current || value);
  }
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">{terms.idea}s</h1>
        <p className="vc-facts">
          {list.length
            ? `${plural(list.length, terms.idea.toLowerCase())} · newest first`
            : "Write things down before they slip away."}
        </p>
      </header>
      <form
        className="vc-capture"
        onSubmit={(event) => {
          event.preventDefault();
          void capture();
        }}
      >
        <Input
          inputSize="lg"
          aria-label={`New ${terms.idea.toLowerCase()}`}
          placeholder={`Write an ${terms.idea.toLowerCase()} down, then press ↩`}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </form>
      {list.length > 0 && (
        <section className="vc-section" aria-label={`${terms.idea}s`}>
          <ul className="vc-list">
            {list.map((idea) => {
              const where = [
                ...(idea.sessionIds ?? []).map((id) => sessionTitle.get(id)).filter(Boolean),
                ...(idea.projectIds ?? []).map((id) => projectTitle.get(id)).filter(Boolean),
              ];
              return (
                <li key={idea.ideaId} className="vc-row">
                  <span className="lead">
                    <Icon name="pencil" size={16} />
                  </span>
                  <span className="main">
                    <span className="title static wrap">{idea.text}</span>
                    <span className="sub">{where.length ? "In " + where.join(", ") : "Not used yet"}</span>
                  </span>
                  <span className="end">
                    <span className="when">{relativeTime(idea.createdAt)}</span>
                    <Menu
                      label={`Actions for ${terms.idea.toLowerCase()}`}
                      items={[
                        {
                          label: `Start a ${terms.session.toLowerCase()}`,
                          onSelect: () =>
                            void run<{ sessionId: string }>("vc.StartSession", {
                              title: idea.text.slice(0, 60),
                              ideaIds: [idea.ideaId],
                            }).then((r) => r && navigate("/s/" + r.sessionId)),
                        },
                        { label: `Add to a ${terms.project.toLowerCase()}`, onSelect: () => setAdding(idea) },
                        {
                          label: "Move to Trash",
                          tone: "danger",
                          separatorBefore: true,
                          onSelect: () => void actions.trash("idea", idea.ideaId, idea.text.slice(0, 40)),
                        },
                      ]}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <PickDialog
        open={adding !== undefined}
        title={`Add to a ${terms.project.toLowerCase()}`}
        label={terms.project}
        submitLabel="Add"
        options={(projects.data ?? [])
          .filter((p) => !p.ideaIds?.includes(adding?.ideaId ?? ""))
          .map((p) => ({ id: p.projectId, title: p.title }))}
        onClose={() => setAdding(undefined)}
        onPick={(projectId) =>
          run("vc.AttachProjectItem", { projectId, item: { kind: "idea", id: adding?.ideaId ?? "" } })
        }
      />
    </div>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const run = useRun(),
    [title, setTitle] = useState(""),
    [background, setBackground] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    const created = await run<{ projectId: string }>("vc.CreateProject", {
      title: title.trim(),
      ...(background.trim() ? { background: background.trim() } : {}),
    });
    setBusy(false);
    if (created) {
      setTitle("");
      setBackground("");
      onClose();
      navigate("/p/" + created.projectId);
    }
  }
  return (
    <Dialog
      open={open}
      title={`New ${terms.project.toLowerCase()}`}
      lede={`A ${terms.project.toLowerCase()} gathers ${terms.idea.toLowerCase()}s, ${terms.draft.toLowerCase()}s and ${terms.session.toLowerCase()}s that belong together.`}
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

export function ProjectsView() {
  const projects = useLiveQuery<Project[]>("vc.Projects", {}),
    [creating, setCreating] = useState(false);
  if (projects.loading) return <PageSkeleton />;
  const list = [...(projects.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">{terms.project}s</h1>
        <p className="vc-facts">
          {list.length ? plural(list.length, terms.project.toLowerCase()) : "Nothing gathered yet."}
        </p>
        <div className="vc-actions">
          <Button variant="primary" leadingIcon={<Icon name="plus" />} onClick={() => setCreating(true)}>
            New {terms.project.toLowerCase()}
          </Button>
        </div>
      </header>
      {list.length > 0 && (
        <section className="vc-section" aria-label={`${terms.project}s`}>
          <ul className="vc-list">
            {list.map((p) => (
              <li key={p.projectId} className="vc-row">
                <span className="lead">
                  <Icon name="briefcase" size={20} />
                </span>
                <span className="main">
                  <a className="title" href={"#/p/" + p.projectId}>
                    {p.title}
                  </a>
                  <span className="sub">
                    {[
                      plural(p.ideaIds?.length ?? 0, terms.idea.toLowerCase()),
                      plural(p.artifactIds?.length ?? 0, terms.draft),
                      plural(p.sessionIds?.length ?? 0, terms.session.toLowerCase()),
                    ].join(" · ")}
                  </span>
                </span>
                <span className="end">
                  <span className="when">{relativeTime(p.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export function ProjectView({
  projectId,
  sessions,
  drafts,
}: {
  projectId: string;
  sessions: SessionRow[];
  drafts: DraftRow[];
}) {
  const projects = useLiveQuery<Project[]>("vc.Projects", {}),
    ideas = useLiveQuery<Idea[]>("vc.Ideas", {}),
    run = useRun(),
    [adding, setAdding] = useState<ItemKind>();
  if (projects.loading) return <PageSkeleton />;
  const project = projects.data?.find((p) => p.projectId === projectId);
  if (!project)
    return (
      <div className="vc-page">
        <h1 className="vc-display">{terms.project} not found</h1>
      </div>
    );
  const all: Record<ItemKind, Array<{ id: string; title: string; href?: string }>> = {
    idea: (ideas.data ?? []).map((i) => ({ id: i.ideaId, title: i.text })),
    artifact: drafts.map((d) => ({
      id: d.artifactId,
      title: d.title,
      ...(d.sessionIds[0] ? { href: `#/s/${d.sessionIds[0]}/d/${d.artifactId}` } : {}),
    })),
    session: sessions.map((s) => ({ id: s.sessionId, title: s.title, href: "#/s/" + s.sessionId })),
  };
  const inProject: Record<ItemKind, string[]> = {
    idea: project.ideaIds ?? [],
    artifact: project.artifactIds ?? [],
    session: project.sessionIds ?? [],
  };
  const detach = (kind: ItemKind, id: string) => void run("vc.DetachProjectItem", { projectId, item: { kind, id } });
  return (
    <div className="vc-page">
      <header className="vc-header">
        <p className="vc-label">{terms.project}</p>
        <h1 className="vc-display">{project.title}</h1>
        {project.background && <p className="vc-lede">{project.background}</p>}
      </header>
      {(["idea", "artifact", "session"] as const).map((kind) => {
        const rows = all[kind].filter((x) => inProject[kind].includes(x.id));
        return (
          <section key={kind} className="vc-section" aria-label={`${kindWords[kind]}s`}>
            <div className="vc-section-head">
              <h2 className="vc-label">{kindWords[kind]}s</h2>
              <button type="button" className="vc-link-button" onClick={() => setAdding(kind)}>
                Add
              </button>
            </div>
            {rows.length ? (
              <ul className="vc-list">
                {rows.map((row) => (
                  <li key={row.id} className="vc-row">
                    <span className="lead">
                      <Icon
                        name={kind === "idea" ? "pencil" : kind === "artifact" ? "document-text" : "chevron-right"}
                        size={16}
                      />
                    </span>
                    <span className="main">
                      {row.href ? (
                        <a className="title" href={row.href}>
                          {row.title}
                        </a>
                      ) : (
                        <span className="title static wrap">{row.title}</span>
                      )}
                    </span>
                    <span className="end">
                      <Menu
                        label={`Actions for ${row.title.slice(0, 30)}`}
                        items={[
                          { label: `Remove from ${terms.project.toLowerCase()}`, onSelect: () => detach(kind, row.id) },
                        ]}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="vc-muted small">None yet.</p>
            )}
          </section>
        );
      })}
      <PickDialog
        open={adding !== undefined}
        title={`Add a ${adding ? kindWords[adding].toLowerCase() : ""}`}
        label={adding ? kindWords[adding] : ""}
        submitLabel="Add"
        options={
          adding
            ? all[adding].filter((x) => !inProject[adding].includes(x.id)).map(({ id, title }) => ({ id, title }))
            : []
        }
        onClose={() => setAdding(undefined)}
        onPick={(id) => run("vc.AttachProjectItem", { projectId, item: { kind: adding, id } })}
      />
    </div>
  );
}
