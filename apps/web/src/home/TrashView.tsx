import { useEffect, useState } from "react";
import { Button, Field, Icon, Input } from "@wei/design-system";
import type { VcPurgePreviewOperation } from "../../../../contract/generated/index.js";
import { errorMessage } from "../copy/errors.js";
import { terms } from "../copy/terms.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import { navigate } from "../shell/prefs.js";
import { Dialog } from "../ui/Dialog.js";
import { useToast } from "../ui/Toast.js";
import { plural } from "../ui/time.js";
import { newCommandId } from "../bridge/webBridge.js";

type Kind = "artifact" | "session" | "idea" | "project";
interface Item {
  kind: Kind;
  id: string;
  title: string;
}
type Preview = VcPurgePreviewOperation["result"];

const kindWord: Record<Kind, string> = {
  artifact: terms.draft,
  session: terms.session,
  idea: terms.idea,
  project: terms.project,
};

/** One plain sentence for a purge preview. Exported for tests. */
export function purgeSentence(previews: Preview[]): string {
  const sum = (key: keyof Preview) =>
    previews.reduce((n, p) => n + (Array.isArray(p[key]) ? (p[key] as unknown[]).length : 0), 0);
  const parts = [
    sum("revisionHashes") ? plural(sum("revisionHashes"), "piece") + " of text history" : undefined,
    sum("commentIds") ? plural(sum("commentIds"), "comment") : undefined,
    sum("blobHashes") ? plural(sum("blobHashes"), "image") : undefined,
    sum("outputSetIds") ? plural(sum("outputSetIds"), terms.snapshot.toLowerCase()) : undefined,
    sum("digestIds") ? plural(sum("digestIds"), "summary") : undefined,
  ].filter((p): p is string => Boolean(p));
  if (!parts.length) return "This deletes it permanently. You cannot undo this.";
  const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts.at(-1);
  return `This deletes ${list}. You cannot undo this.`;
}

function missing<T>(all: T[] | undefined, live: T[] | undefined, id: (item: T) => string): T[] {
  const present = new Set((live ?? []).map(id));
  return (all ?? []).filter((item) => !present.has(id(item)));
}

/** Things in Trash: present with `includeTrashed`, missing without it. */
function useTrash() {
  type Draft = { artifactId: string; title: string };
  type Session = { sessionId: string; title: string };
  type Idea = { ideaId: string; text: string };
  type Project = { projectId: string; title: string };
  const trashed = { includeTrashed: true },
    drafts = useLiveQuery<Draft[]>("vc.Artifacts", trashed),
    liveDrafts = useLiveQuery<Draft[]>("vc.Artifacts", {}),
    sessions = useLiveQuery<Session[]>("vc.Sessions", trashed),
    liveSessions = useLiveQuery<Session[]>("vc.Sessions", {}),
    ideas = useLiveQuery<Idea[]>("vc.Ideas", trashed),
    liveIdeas = useLiveQuery<Idea[]>("vc.Ideas", {}),
    projects = useLiveQuery<Project[]>("vc.Projects", trashed),
    liveProjects = useLiveQuery<Project[]>("vc.Projects", {});
  const items: Item[] = [
    ...missing(drafts.data, liveDrafts.data, (d) => d.artifactId).map((d) => ({
      kind: "artifact" as const,
      id: d.artifactId,
      title: d.title,
    })),
    ...missing(sessions.data, liveSessions.data, (x) => x.sessionId).map((x) => ({
      kind: "session" as const,
      id: x.sessionId,
      title: x.title,
    })),
    ...missing(projects.data, liveProjects.data, (x) => x.projectId).map((x) => ({
      kind: "project" as const,
      id: x.projectId,
      title: x.title,
    })),
    ...missing(ideas.data, liveIdeas.data, (x) => x.ideaId).map((x) => ({
      kind: "idea" as const,
      id: x.ideaId,
      title: x.text,
    })),
  ];
  const loading = [drafts, liveDrafts, sessions, liveSessions, ideas, liveIdeas, projects, liveProjects].some(
    (q) => q.loading,
  );
  return { items, loading };
}

function PurgeDialog({ items, all, onClose }: { items: Item[]; all: boolean; onClose(): void }) {
  const bridge = useBridge(),
    toast = useToast(),
    [previews, setPreviews] = useState<Preview[]>(),
    [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false);
  const open = items.length > 0,
    expected = all ? "empty trash" : (items[0]?.title ?? "");
  useEffect(() => {
    setTyped("");
    setPreviews(undefined);
    if (!items.length) return;
    void Promise.all(
      items.map((item) => bridge.query<Preview>("vc.PurgePreview", { target: { kind: item.kind, id: item.id } })),
    ).then(setPreviews, () => setPreviews([]));
  }, [items, bridge]);
  async function submit() {
    if (typed.trim() !== expected.trim()) return;
    setBusy(true);
    for (const item of items) {
      const result = await bridge.command("vc.Purge", { target: { kind: item.kind, id: item.id } }, newCommandId());
      if (!result.ok) {
        toast(errorMessage(result.error.code));
        break;
      }
    }
    setBusy(false);
    onClose();
  }
  return (
    <Dialog
      open={open}
      title={all ? "Empty Trash" : `Delete “${items[0]?.title ?? ""}” permanently`}
      lede={previews ? purgeSentence(previews) : "Finding what this deletes…"}
      onClose={onClose}
      onSubmit={() => void submit()}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            loading={busy}
            disabled={typed.trim() !== expected.trim() || !previews}
          >
            Delete permanently
          </Button>
        </>
      }
    >
      <Field label={all ? "Type “empty trash” to confirm" : "Type the title to confirm"}>
        <Input inputSize="lg" value={typed} placeholder={expected} onChange={(event) => setTyped(event.target.value)} />
      </Field>
    </Dialog>
  );
}

export function TrashView() {
  const bridge = useBridge(),
    toast = useToast(),
    { items, loading } = useTrash(),
    settings = useLiveQuery<{ trashRetentionDays?: number }>("sys.Settings", {}),
    [purging, setPurging] = useState<{ items: Item[]; all: boolean }>({ items: [], all: false });
  const days = settings.data?.trashRetentionDays ?? 30;
  const restore = async (item: Item) => {
    const result = await bridge.command("vc.Restore", { target: { kind: item.kind, id: item.id } }, newCommandId());
    if (!result.ok) return toast(errorMessage(result.error.code));
    // Say where it went back to, one click away.
    const where =
      item.kind === "artifact"
        ? "/drafts"
        : item.kind === "session"
          ? "/s/" + item.id
          : item.kind === "project"
            ? "/p/" + item.id
            : "/ideas";
    toast(`“${item.title}” is back`, { label: "Show", run: () => navigate(where) });
  };
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">Trash</h1>
        <p className="vc-facts">
          {loading
            ? "…"
            : items.length
              ? `${plural(items.length, "item")} · deleted permanently after ${days} days`
              : "Empty"}
        </p>
        {items.length > 0 && (
          <div className="vc-actions">
            <Button
              variant="ghost"
              leadingIcon={<Icon name="trash" />}
              onClick={() => setPurging({ items, all: true })}
            >
              Empty Trash
            </Button>
          </div>
        )}
      </header>
      {items.length > 0 && (
        <section className="vc-section" aria-label="In Trash">
          <ul className="vc-list">
            {items.map((item) => (
              <li key={item.kind + item.id} className="vc-row">
                <span className="lead">
                  <Icon
                    name={item.kind === "artifact" ? "document-text" : item.kind === "idea" ? "pencil" : "briefcase"}
                    size={20}
                  />
                </span>
                <span className="main">
                  <span className="title static">{item.title}</span>
                  <span className="sub">{kindWord[item.kind]}</span>
                </span>
                <span className="end">
                  <Button size="sm" variant="ghost" onClick={() => void restore(item)}>
                    Restore
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPurging({ items: [item], all: false })}>
                    Delete permanently
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <PurgeDialog items={purging.items} all={purging.all} onClose={() => setPurging({ items: [], all: false })} />
    </div>
  );
}
