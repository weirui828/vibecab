import { useEffect, useState } from "react";
import type { Settings, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";

type Target = { kind: "artifact" | "session" | "comment"; id: string; title: string };
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
  reviewRuns: Array<{ runId: string }>;
};

export function TrashView({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]),
    [selected, setSelected] = useState<Target>(),
    [preview, setPreview] = useState<Preview>(),
    [emptyPreviews, setEmptyPreviews] = useState<Array<{ target: Target; preview: Preview }>>(),
    [confirmation, setConfirmation] = useState(""),
    [reviewActions, setReviewActions] = useState<Record<string, "redact" | "delete">>({}),
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
    setTargets([
      ...allArtifacts
        .filter((item) => !activeArtifactIds.has(item.artifactId))
        .map((item) => ({ kind: "artifact" as const, id: item.artifactId, title: item.title })),
      ...allSessions
        .filter((item) => !activeSessionIds.has(item.sessionId))
        .map((item) => ({ kind: "session" as const, id: item.sessionId, title: item.title })),
      ...allComments
        .filter((item) => !activeCommentIds.has(item.commentId))
        .map((item) => ({ kind: "comment" as const, id: item.commentId, title: item.body.slice(0, 80) })),
    ]);
    setRetentionDays(settings.trashRetentionDays ?? 30);
  };
  useEffect(() => {
    void load();
  }, []);
  const inspect = async (target: Target) => {
    setSelected(target);
    setConfirmation("");
    setReviewActions({});
    setPreview(
      await window.vibecab.query<Preview>("vc.PurgePreview", { target: { kind: target.kind, id: target.id } }),
    );
  };
  const startEmptyTrash = async () => {
    setSelected(undefined);
    setPreview(undefined);
    setConfirmation("");
    setReviewActions({});
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
  const actions =
    preview?.reviewRuns.flatMap((run) => {
      const action = reviewActions[run.runId];
      return action ? [{ runId: run.runId, action }] : [];
    }) ?? [];
  const purgeAllowed = preview && confirmation === selected?.title && actions.length === preview.reviewRuns.length;
  const emptyRuns =
    emptyPreviews?.flatMap(({ target, preview }) => preview.reviewRuns.map((run) => ({ ...run, target }))) ?? [];
  const emptyReviewActions = emptyRuns.flatMap(({ runId }) => {
    const action = reviewActions[runId];
    return action ? [{ runId, action }] : [];
  });
  return (
    <section aria-label="Trash view">
      <div className="row">
        <h2>Trash</h2>
        <button onClick={onBack}>Back</button>
      </div>
      <p>Items are automatically purged after {retentionDays} days.</p>
      {targets.length ? <button onClick={() => void startEmptyTrash()}>Empty trash</button> : null}
      {targets.map((item) => (
        <article key={`${item.kind}:${item.id}`}>
          <span>{item.title}</span>
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
            <fieldset key={`${run.target.id}:${run.runId}`}>
              <legend>
                {run.target.title}: dependent review run {run.runId}
              </legend>
              {(["redact", "delete"] as const).map((action) => (
                <label key={action}>
                  <input
                    type="radio"
                    name={`empty-${run.target.id}-${run.runId}`}
                    checked={reviewActions[run.runId] === action}
                    onChange={() => setReviewActions((current) => ({ ...current, [run.runId]: action }))}
                  />
                  {action}
                </label>
              ))}
            </fieldset>
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
            disabled={confirmation !== "EMPTY TRASH" || emptyReviewActions.length !== emptyRuns.length}
            onClick={() =>
              void (async () => {
                for (const item of emptyPreviews) {
                  const result = await window.vibecab.command("vc.Purge", {
                    target: { kind: item.target.kind, id: item.target.id },
                    reviewActions: emptyReviewActions.filter((action) =>
                      item.preview.reviewRuns.some((run) => run.runId === action.runId),
                    ),
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
            <fieldset key={run.runId}>
              <legend>Dependent review run {run.runId}</legend>
              {(["redact", "delete"] as const).map((action) => (
                <label key={action}>
                  <input
                    type="radio"
                    name={`run-${run.runId}`}
                    checked={reviewActions[run.runId] === action}
                    onChange={() => setReviewActions((current) => ({ ...current, [run.runId]: action }))}
                  />
                  {action}
                </label>
              ))}
            </fieldset>
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
                  reviewActions: actions,
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
