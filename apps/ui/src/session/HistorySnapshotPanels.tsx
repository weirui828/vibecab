import { useEffect, useState } from "react";
import type { OutputSet, VcVersionsOperation } from "../../../../contract/generated/index.js";

export function HistoryPanel({
  artifactId,
  headVersion,
  open,
  onToggle,
  onView,
  onRestore,
  onCompare,
}: {
  artifactId: string;
  headVersion: number;
  open: boolean;
  onToggle: () => void;
  onView: (version: number) => void;
  onRestore: (version: number, nextVersion: number) => void;
  onCompare: (from: number, to: number) => void;
}) {
  const [history, setHistory] = useState<VcVersionsOperation["result"]>([]),
    [compareFrom, setCompareFrom] = useState(1),
    [compareTo, setCompareTo] = useState(headVersion);
  return (
    <>
      <button
        onClick={() => {
          onToggle();
          if (!open)
            void window.vibecab.query<VcVersionsOperation["result"]>("vc.Versions", { artifactId }).then(setHistory);
        }}
      >
        History
      </button>
      {open ? (
        <section aria-label="Version history" className="history-panel">
          <h2>History</h2>
          {history.map((item) => (
            <article key={item.version}>
              <p>
                <span>Version {item.version}</span> · {new Date(item.createdAt).toLocaleString()} ·{" "}
                {versionSource(item.source)}
              </p>
              <button aria-label={`View version ${item.version}`} onClick={() => onView(item.version)}>
                View version {item.version}
              </button>
              <button
                aria-label={`Restore version ${item.version}`}
                onClick={() => onRestore(item.version, headVersion + 1)}
              >
                Restore version {item.version}
              </button>
            </article>
          ))}
          {history.length > 1 ? (
            <div className="version-compare">
              <label>
                Compare from
                <select
                  aria-label="Compare from version"
                  value={compareFrom}
                  onChange={(event) => setCompareFrom(Number(event.target.value))}
                >
                  {history.map((item) => (
                    <option key={item.version} value={item.version}>
                      v{item.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                to
                <select
                  aria-label="Compare to version"
                  value={compareTo}
                  onChange={(event) => setCompareTo(Number(event.target.value))}
                >
                  {history.map((item) => (
                    <option key={item.version} value={item.version}>
                      v{item.version}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => onCompare(compareFrom, compareTo)}>Compare</button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

export function SnapshotPanel({
  sessionId,
  artifacts,
  snapshots,
  onCreated,
  onExportQueued,
}: {
  sessionId: string;
  artifacts: { artifactId: string; title: string; headVersion: number }[];
  snapshots: OutputSet[];
  onCreated: () => Promise<void>;
  onExportQueued: (exportId: string) => void;
}) {
  const [showForm, setShowForm] = useState(false),
    [label, setLabel] = useState("");
  return (
    <>
      <button onClick={() => setShowForm((shown) => !shown)}>Save Snapshot</button>
      {showForm ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void window.vibecab
              .command("vc.CreateOutputSet", {
                sessionId,
                artifactIds: artifacts.map((item) => item.artifactId),
                ...(label ? { label } : {}),
              })
              .then(async (result) => {
                if (result.ok) {
                  setShowForm(false);
                  setLabel("");
                  await onCreated();
                }
              });
          }}
        >
          <label>
            Snapshot label
            <input aria-label="Snapshot label" value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <button type="submit">Create Snapshot</button>
        </form>
      ) : null}
      {snapshots.map((snapshot) => (
        <SnapshotRow key={snapshot.outputSetId} snapshot={snapshot} onExportQueued={onExportQueued} />
      ))}
    </>
  );
}

function SnapshotRow({
  snapshot,
  onExportQueued,
}: {
  snapshot: OutputSet;
  onExportQueued: (exportId: string) => void;
}) {
  const [showFormats, setShowFormats] = useState(false),
    [includeThreads, setIncludeThreads] = useState(false),
    [includeDecisionRecord, setIncludeDecisionRecord] = useState(false),
    [message, setMessage] = useState(""),
    [labels, setLabels] = useState<Array<{ labelId: string; label: string }>>([]),
    [newLabel, setNewLabel] = useState("");
  const refreshLabels = () =>
    window.vibecab
      .query<Array<{ labelId: string; label: string }>>("vc.Labels", { outputSetId: snapshot.outputSetId })
      .then(setLabels);
  useEffect(() => {
    void refreshLabels();
  }, [snapshot.outputSetId]);
  return (
    <article className="snapshot-row">
      <strong>{snapshot.label ?? "Snapshot"}</strong>
      {labels.map((item) => (
        <span key={item.labelId} className="label-chip">
          {item.label}
        </span>
      ))}
      <label>
        Add label
        <input
          aria-label={`Label ${snapshot.outputSetId}`}
          value={newLabel}
          onChange={(event) => setNewLabel(event.target.value)}
        />
      </label>
      <button
        onClick={() => {
          if (!newLabel.trim()) return;
          void window.vibecab
            .command("vc.Label", { target: { outputSetId: snapshot.outputSetId }, label: newLabel.trim() })
            .then(async (result) => {
              if (result.ok) {
                setNewLabel("");
                await refreshLabels();
              } else setMessage(result.error.message);
            });
        }}
      >
        Add label
      </button>
      <button onClick={() => setShowFormats((shown) => !shown)}>Export Snapshot</button>
      {showFormats ? (
        <div>
          <label>
            <input
              type="checkbox"
              checked={includeThreads}
              onChange={(event) => setIncludeThreads(event.target.checked)}
            />
            Include threads
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeDecisionRecord}
              onChange={(event) => setIncludeDecisionRecord(event.target.checked)}
            />
            Include decision record
          </label>
          {(["markdown", "html", "json"] as const).map((format) => (
            <button
              key={format}
              onClick={() => {
                void window.vibecab
                  .command("vc.Export", {
                    target: { outputSetId: snapshot.outputSetId },
                    format,
                    include: { threads: includeThreads, decisionRecord: includeDecisionRecord },
                  })
                  .then((result) => {
                    if (!result.ok) return setMessage(result.error.message);
                    const exportId =
                      typeof result.result === "object" && result.result !== null
                        ? Reflect.get(result.result, "exportId")
                        : undefined;
                    if (typeof exportId === "string") onExportQueued(exportId);
                    setMessage("Export queued");
                  });
              }}
            >
              Export {format === "markdown" ? "Markdown" : format.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}
      <p role="status">{message}</p>
    </article>
  );
}

function versionSource(source: VcVersionsOperation["result"][number]["source"]): string {
  if (typeof source.updateId === "string") return "Update by the agent for you";
  if (typeof source.restoreOf === "number") return `Restored from v${source.restoreOf}`;
  if (typeof source.importId === "string") return "Imported";
  return "Your edit";
}
