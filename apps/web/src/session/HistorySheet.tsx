import { useEffect, useState } from "react";
import { Button, Checkbox, Field, Icon, IconButton, Input } from "@wei/design-system";
import type { OutputSet, Version } from "../../../../contract/generated/index.js";
import { errorMessage } from "../copy/errors.js";
import { terms } from "../copy/terms.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import type { DraftRow } from "../live/workspace.js";
import { Dialog } from "../ui/Dialog.js";
import { useToast } from "../ui/Toast.js";
import { relativeTime } from "../ui/time.js";
import { newCommandId } from "../bridge/webBridge.js";
import type { ExportTarget } from "./ExportDialog.js";

interface Label {
  labelId: string;
  label: string;
  target: { outputSetId: string } | { artifactId: string; version: number };
}

/** How a version came to be, in words. Exported for tests. */
export function versionOrigin(version: Pick<Version, "version" | "source" | "createdBy">): string {
  const source = version.source;
  if (source.restoreOf) return `Restored from version ${source.restoreOf}`;
  if (source.updateId) return `${terms.update} by the agent for you`;
  if (source.editId) return "Your edit";
  if (source.importId) return version.version === 1 ? "Imported" : "Added from a file";
  return version.version === 1 ? "Started" : "Changed";
}

function useRun() {
  const bridge = useBridge(),
    toast = useToast();
  return async (type: string, payload: unknown) => {
    const result = await bridge.command(type, payload, newCommandId());
    if (!result.ok) toast(errorMessage(result.error.code));
    return result.ok;
  };
}

function AddLabel({ outputSetId }: { outputSetId: string }) {
  const run = useRun(),
    [open, setOpen] = useState(false),
    [value, setValue] = useState("");
  if (!open)
    return (
      <button type="button" className="vc-link-button" onClick={() => setOpen(true)}>
        Add label
      </button>
    );
  return (
    <form
      className="vc-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        void run("vc.Label", { target: { outputSetId }, label: value.trim() }).then((ok) => {
          if (ok) {
            setValue("");
            setOpen(false);
          }
        });
      }}
    >
      <input
        autoFocus
        aria-label="Label"
        placeholder="Sent to editor"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" size="sm" variant="secondary">
        Add
      </Button>
    </form>
  );
}

/** Versions and Snapshots of the session's Drafts, in a sheet from the right. */
export function HistorySheet({
  sessionId,
  draft,
  drafts,
  viewing,
  onView,
  onExport,
  onClose,
}: {
  sessionId: string;
  draft: DraftRow;
  drafts: DraftRow[];
  viewing: number | undefined;
  onView(version: number | undefined): void;
  onExport(target: ExportTarget, title: string): void;
  onClose(): void;
}) {
  const versions = useLiveQuery<Version[]>("vc.Versions", { artifactId: draft.artifactId }),
    snapshots = useLiveQuery<OutputSet[]>("vc.OutputSets", { sessionId }),
    labels = useLiveQuery<Label[]>("vc.Labels", {});
  const titles = new Map(drafts.map((d) => [d.artifactId, d.title]));
  const labelsFor = (match: (l: Label) => boolean) => (labels.data ?? []).filter(match).map((l) => l.label);
  const ordered = [...(versions.data ?? [])].sort((a, b) => b.version - a.version),
    head = ordered[0]?.version;
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <aside className="vc-sheet-threads vc-history" aria-label="History">
      <header>
        <h2 className="vc-label">History · {draft.title}</h2>
        <IconButton variant="ghost" size="md" label="Close history" icon={<Icon name="x-mark" />} onClick={onClose} />
      </header>
      <div className="list">
        <ul className="vc-versions">
          {ordered.map((v) => {
            const chips = [
              ...labelsFor(
                (l) =>
                  "artifactId" in l.target &&
                  l.target.artifactId === draft.artifactId &&
                  l.target.version === v.version,
              ),
              ...(snapshots.data ?? [])
                .filter((s) => s.members.some((m) => m.artifactId === draft.artifactId && m.version === v.version))
                .map((s) => s.label ?? terms.snapshot),
            ];
            const current = (viewing ?? head) === v.version;
            return (
              <li key={v.version} data-current={current || undefined}>
                <button type="button" onClick={() => onView(v.version === head ? undefined : v.version)}>
                  <span className="title">
                    Version {v.version}
                    {v.version === head && <span className="vc-facts"> · latest</span>}
                  </span>
                  <span className="sub">{versionOrigin(v)}</span>
                  <span className="vc-facts">{relativeTime(v.createdAt)}</span>
                  {chips.length > 0 && (
                    <span className="chips">
                      {chips.map((chip, i) => (
                        <span key={i} className="vc-tag">
                          {chip}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            onExport(
              { artifactId: draft.artifactId, ...(viewing ? { version: viewing } : {}) },
              viewing ? `${draft.title} v${viewing}` : draft.title,
            )
          }
        >
          Export {viewing ? `version ${viewing}` : "the latest version"}…
        </Button>

        <h3 className="vc-label section">{terms.snapshot}s</h3>
        {(snapshots.data ?? []).length === 0 ? (
          <p className="vc-muted small">
            A {terms.snapshot.toLowerCase()} keeps these exact versions together, to share or export later.
          </p>
        ) : (
          <ul className="vc-snapshots">
            {[...(snapshots.data ?? [])].reverse().map((s) => {
              const extra = labelsFor((l) => "outputSetId" in l.target && l.target.outputSetId === s.outputSetId);
              return (
                <li key={s.outputSetId}>
                  <span className="title">{s.label ?? terms.snapshot}</span>
                  <span className="vc-facts">{relativeTime(s.createdAt)}</span>
                  <span className="sub">
                    {s.members
                      .map((m) => `${titles.get(m.artifactId) ?? terms.draft} · version ${m.version}`)
                      .join(", ")}
                  </span>
                  {extra.length > 0 && (
                    <span className="chips">
                      {extra.map((chip, i) => (
                        <span key={i} className="vc-tag">
                          {chip}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="row">
                    <button
                      type="button"
                      className="vc-link-button"
                      onClick={() => onExport({ outputSetId: s.outputSetId }, s.label ?? terms.snapshot)}
                    >
                      Export…
                    </button>
                    <AddLabel outputSetId={s.outputSetId} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

export function SnapshotDialog({
  open,
  sessionId,
  drafts,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  drafts: DraftRow[];
  onClose(): void;
}) {
  const run = useRun(),
    toast = useToast(),
    [chosen, setChosen] = useState<string[]>([]),
    [label, setLabel] = useState(""),
    [busy, setBusy] = useState(false);
  // Reset only when the dialog opens: live refreshes of the Draft list must not wipe what is being typed.
  const draftIds = drafts.map((d) => d.artifactId).join(" ");
  useEffect(() => {
    if (open) {
      setChosen(draftIds ? draftIds.split(" ") : []);
      setLabel("");
    }
  }, [open]);
  async function submit() {
    if (!chosen.length) return;
    setBusy(true);
    const ok = await run("vc.CreateOutputSet", {
      sessionId,
      artifactIds: chosen,
      ...(label.trim() ? { label: label.trim() } : {}),
    });
    setBusy(false);
    if (ok) {
      toast(`${terms.snapshot} saved`);
      onClose();
    }
  }
  return (
    <Dialog
      open={open}
      title={`Save a ${terms.snapshot.toLowerCase()}`}
      lede={`Keeps the current version of each ${terms.draft.toLowerCase()} together. Later changes leave it as it is.`}
      onClose={onClose}
      onSubmit={() => void submit()}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!chosen.length}>
            Save
          </Button>
        </>
      }
    >
      {drafts.length > 1 && (
        <div className="vc-checks" role="group" aria-label={`${terms.draft}s`}>
          {drafts.map((d) => (
            <Checkbox
              key={d.artifactId}
              label={d.title}
              checked={chosen.includes(d.artifactId)}
              onChange={(event) =>
                setChosen((list) =>
                  event.target.checked ? [...list, d.artifactId] : list.filter((id) => id !== d.artifactId),
                )
              }
            />
          ))}
        </div>
      )}
      <Field label="Label (optional)">
        <Input inputSize="lg" placeholder="v1 final" value={label} onChange={(event) => setLabel(event.target.value)} />
      </Field>
    </Dialog>
  );
}
