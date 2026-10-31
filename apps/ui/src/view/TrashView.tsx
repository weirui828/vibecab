import { useEffect, useState } from "react";
import type { Settings, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";

type Target = { kind: "artifact" | "session" | "comment"; id: string; title: string; reviewCount: number };
type Preview = {
  recordIds: string[];
  revisionHashes: string[];
  blobHashes: string[];
  manifestIds: string[];
  digestIds: string[];
  commentIds: string[];
  agreementIds: string[];
  updateIds: string[];
  conflictIds: string[];
  outputSetIds: string[];
  reviewRuns: Array<{ runId: string; action: "redact" | "delete"; active: boolean; removes: string[] }>;
};

export function TrashView({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]),
    [selected, setSelected] = useState<Target>(),
    [preview, setPreview] = useState<Preview>(),
    [emptyPreviews, setEmptyPreviews] = useState<Array<{ target: Target; preview: Preview }>>(),
    [confirmation, setConfirmation] = useState(""),
    [retentionDays, setRetentionDays] = useState(30),
    [message, setMessage] = useState("");
  const load = async () => {
    const [allArtifacts, activeArtifacts, allSessions, activeSessions, allComments, activeComments, settings] =
      await Promise.all([
        window.vibecab.query<VcArtifactsOperation["result"]>("vc.Artifacts", { includeTrashed: true }),
        window.vibecab.query<VcArtifactsOperation["result"]>("vc.Artifacts", {}),
        window.vibecab.query<VcSessionsOperation["result"]>("vc.Sessions", { includeTrashed: true }),
        window.vibecab.query<VcSessionsOperation["result"]>("vc.Sessions", {}),
        window.vibecab.query<Array<{ commentId: string; body: string }>>("vc.FeedbackItems", { includeTrashed: true }),
        window.vibecab.query<Array<{ commentId: string }>>("vc.FeedbackItems", {}),
        window.vibecab.query<Settings>("sys.Settings", {}),
      ]);
    const activeArtifactIds = new Set(activeArtifacts.map((item) => item.artifactId)),
      activeSessionIds = new Set(activeSessions.map((item) => item.sessionId)),
      activeCommentIds = new Set(activeComments.map((item) => item.commentId));
    const nextTargets = [
      ...allArtifacts
        .filter((item) => !activeArtifactIds.has(item.artifactId))
        .map((item) => ({ kind: "artifact" as const, id: item.artifactId, title: item.title })),
      ...allSessions
        .filter((item) => !activeSessionIds.has(item.sessionId))
        .map((item) => ({ kind: "session" as const, id: item.sessionId, title: item.title })),
      ...allComments
        .filter((item) => !activeCommentIds.has(item.commentId))
        .map((item) => ({ kind: "comment" as const, id: item.commentId, title: item.body.slice(0, 80) })),
    ];
    const withReviewCounts = await Promise.all(
      nextTargets.map(async (target) => {
        const preview = await window.vibecab.query<Preview>("vc.PurgePreview", {
          target: { kind: target.kind, id: target.id },
        });
        return { ...target, reviewCount: preview.reviewRuns.length };
      }),
    );
    setTargets(withReviewCounts);
    setRetentionDays(settings.trashRetentionDays ?? 30);
  };
  useEffect(() => {
    void load();
  }, []);
  const inspect = async (target: Target) => {
    setSelected(target);
    setConfirmation("");
    setPreview(
      await window.vibecab.query<Preview>("vc.PurgePreview", { target: { kind: target.kind, id: target.id } }),
    );
  };
  const startEmptyTrash = async () => {
    setSelected(undefined);
    setPreview(undefined);
    setConfirmation("");
    const items = await Promise.all(
      targets.map(async (target) => ({
        target,
        preview: await window.vibecab.query<Preview>("vc.PurgePreview", {
          target: { kind: target.kind, id: target.id },
        }),
      })),
    );
    setEmptyPreviews(items);
  };
  const purgeAllowed = preview && confirmation === selected?.title;
  const emptyRuns =
    emptyPreviews?.flatMap(({ target, preview }) => preview.reviewRuns.map((run) => ({ ...run, target }))) ?? [];
  return (
    <section aria-label="Trash view" className="trash-view page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2 className="page-title">Trash</h2>
          <p className="meta">Items are automatically purged after {retentionDays} days.</p>
        </div>
        <div className="page-actions">
          <button onClick={onBack}>Back</button>
        </div>
      </header>
      {targets.length ? <button onClick={() => void startEmptyTrash()}>Empty trash</button> : null}
      {targets.map((item) => (
        <article key={`${item.kind}:${item.id}`}>
          <span>
            {item.title}
            {item.reviewCount > 0 ? (
              <small className="meta">
                {item.reviewCount} {item.reviewCount === 1 ? "review quoted" : "reviews quoted"} this{" "}
                {item.kind === "artifact" ? terms.draft : item.kind === "session" ? terms.session : "comment"}; quoted
                content will be removed when purged.
              </small>
            ) : null}
          </span>
          <button
            onClick={() =>
              void window.vibecab
                .command("vc.Restore", { target: { kind: item.kind, id: item.id } })
                .then(async (result) => {
                  setMessage(result.ok ? "Restored" : result.error.message);
                  if (result.ok) {
                    await load();
                    onChanged();
                  }
                })
            }
          >
            Restore
          </button>
          <button onClick={() => void inspect(item)}>Delete permanently</button>
        </article>
      ))}
      {!targets.length ? <p>Trash is empty.</p> : null}
      {emptyPreviews ? (
        <section aria-label="Empty trash confirmation">
          <h3>Empty trash?</h3>
          <p>
            This removes {emptyPreviews.reduce((sum, item) => sum + item.preview.recordIds.length, 0)} records,{" "}
            {emptyPreviews.reduce((sum, item) => sum + item.preview.revisionHashes.length, 0)} versions,{" "}
            {emptyPreviews.reduce((sum, item) => sum + item.preview.blobHashes.length, 0)} images and{" "}
            {emptyPreviews.reduce((sum, item) => sum + item.preview.commentIds.length, 0)} comments. It cannot be
            undone.
          </p>
          {emptyRuns.map((run) => (
            <p key={`${run.target.id}:${run.runId}`}>
              {run.target.title}: review {run.runId} will be{" "}
              {run.action === "delete" ? "deleted" : "kept with the purged source redacted"}.
            </p>
          ))}
          <label>
            Type EMPTY TRASH to confirm
            <input
              aria-label="Empty trash confirmation text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button
            disabled={confirmation !== "EMPTY TRASH"}
            onClick={() =>
              void (async () => {
                for (const item of emptyPreviews) {
                  const result = await window.vibecab.command("vc.Purge", {
                    target: { kind: item.target.kind, id: item.target.id },
                  });
                  if (!result.ok) {
                    setMessage(result.error.message);
                    return;
                  }
                }
                setEmptyPreviews(undefined);
                setMessage("Trash emptied");
                await load();
                onChanged();
              })()
            }
          >
            Empty trash permanently
          </button>
          <button onClick={() => setEmptyPreviews(undefined)}>Cancel</button>
        </section>
      ) : null}
      {selected && preview ? (
        <section aria-label="Purge confirmation">
          <h3>Delete permanently?</h3>
          <p>
            This removes {preview.recordIds.length} records, {preview.revisionHashes.length} versions,{" "}
            {preview.blobHashes.length} images and {preview.commentIds.length} comments. It cannot be undone.
          </p>
          {preview.reviewRuns.map((run) => (
            <p key={run.runId}>
              Review {run.runId} will be {run.action === "delete" ? "deleted" : "kept with the purged source redacted"}.
            </p>
          ))}
          <label>
            Type “{selected.title}” to confirm
            <input
              aria-label="Purge confirmation text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button
            disabled={!purgeAllowed}
            onClick={() =>
              void window.vibecab
                .command("vc.Purge", {
                  target: { kind: selected.kind, id: selected.id },
                })
                .then((result) => {
                  setMessage(result.ok ? "Permanent deletion queued" : result.error.message);
                  setSelected(undefined);
                  setPreview(undefined);
                })
            }
          >
            Delete permanently
          </button>
          <button
            onClick={() => {
              setSelected(undefined);
              setPreview(undefined);
            }}
          >
            Cancel
          </button>
        </section>
      ) : null}
      <p role="status">{message}</p>
    </section>
  );
}
