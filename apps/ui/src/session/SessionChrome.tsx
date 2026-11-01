import type { Dispatch, SetStateAction } from "react";
import type { DiffResult, OutputSet } from "../../../../contract/generated/index.js";
import { HistoryPanel, SnapshotPanel } from "./HistorySnapshotPanels.js";

type ArtifactItem = { artifactId: string; title: string; headVersion: number };

export function SessionHeader(props: {
  title: string;
  artifact?: ArtifactItem;
  artifacts: ArtifactItem[];
  sessionId: string;
  snapshots: OutputSet[];
  showHistory: boolean;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  setViewingVersion: Dispatch<SetStateAction<number | undefined>>;
  setActiveArtifactId: Dispatch<SetStateAction<string>>;
  setComparison: Dispatch<SetStateAction<DiffResult | undefined>>;
  refresh: () => Promise<void>;
  setPendingExportId: Dispatch<SetStateAction<string | undefined>>;
  setShowThreads: Dispatch<SetStateAction<boolean>>;
  onBack: () => void;
  meta?: string;
}) {
  const { artifact, artifacts } = props;
  return (
    <header className="session-header">
      <div className="session-heading">
        <p className="eyebrow">
          <button className="crumb" onClick={props.onBack}>
            Home
          </button>
          <span aria-hidden="true"> / </span>
          {props.title}
        </p>
        <h2 className="page-title">{artifact?.title ?? "No Draft"}</h2>
        <p className="meta">
          <span>v{artifact?.headVersion ?? "—"}</span>
          {props.meta ? <span> · {props.meta}</span> : null}
        </p>
      </div>
      <div className="session-actions">
        {artifact ? (
          <HistoryPanel
            artifactId={artifact.artifactId}
            headVersion={artifact.headVersion}
            open={props.showHistory}
            onToggle={() => props.setShowHistory((shown) => !shown)}
            onView={props.setViewingVersion}
            onRestore={(version, nextVersion) => {
              if (window.confirm(`Creates v${nextVersion} with the content of v${version}. Nothing is lost.`))
                void window.vibecab
                  .command("vc.RestoreVersion", { artifactId: artifact.artifactId, version })
                  .then(props.refresh);
            }}
            onCompare={(from, to) =>
              void window.vibecab
                .query<DiffResult>("vc.Diff", { artifactId: artifact.artifactId, from, to })
                .then((result) => {
                  props.setComparison(result);
                  props.setViewingVersion(to);
                })
            }
          />
        ) : null}
        <SnapshotPanel
          sessionId={props.sessionId}
          artifacts={artifacts}
          snapshots={props.snapshots}
          onCreated={props.refresh}
          onExportQueued={props.setPendingExportId}
          onViewVersion={(artifactId, version) => {
            props.setActiveArtifactId(artifactId);
            props.setViewingVersion(version);
          }}
          onCompare={(artifactId, from, to) =>
            void window.vibecab.query<DiffResult>("vc.Diff", { artifactId, from, to }).then((result) => {
              props.setComparison(result);
              props.setViewingVersion(to);
            })
          }
        />
        <button aria-label="Toggle threads" onClick={() => props.setShowThreads((shown) => !shown)}>
          Threads
        </button>
      </div>
    </header>
  );
}

export function SessionSidebar(props: {
  artifacts: ArtifactItem[];
  sessionState: "active" | "paused" | "ended";
  activeArtifactId: string;
  setActiveArtifactId: Dispatch<SetStateAction<string>>;
  availableArtifacts: ArtifactItem[];
  sessionId: string;
  setArtifacts: Dispatch<SetStateAction<ArtifactItem[]>>;
  onAddDraft: () => Promise<void>;
  onRefresh: () => void;
}) {
  return (
    <nav className="session-sidebar" aria-label="Session drafts">
      <h2 className="eyebrow">Drafts</h2>
      {props.artifacts.length ? (
        props.artifacts.map((item) => (
          <button
            key={item.artifactId}
            className="rail-draft"
            aria-current={item.artifactId === props.activeArtifactId}
            onClick={() => props.setActiveArtifactId(item.artifactId)}
          >
            {item.title}
          </button>
        ))
      ) : (
        <p>No Draft attached</p>
      )}
      <button className="rail-add" onClick={() => void props.onAddDraft()}>
        Add new Draft
      </button>
      {props.availableArtifacts.some((item) => !props.artifacts.some((a) => a.artifactId === item.artifactId)) ? (
        <details className="rail-attach-list">
          <summary>Attach an existing Draft</summary>
          {props.availableArtifacts
            .filter((item) => !props.artifacts.some((attached) => attached.artifactId === item.artifactId))
            .map((item) => (
              <button
                key={item.artifactId}
                className="rail-attach"
                onClick={() =>
                  void window.vibecab
                    .command("vc.AttachArtifact", {
                      sessionId: props.sessionId,
                      artifactId: item.artifactId,
                      role: "supporting",
                    })
                    .then((result) => {
                      if (result.ok) {
                        props.setArtifacts((current) => [...current, item]);
                        props.setActiveArtifactId(item.artifactId);
                      }
                    })
                }
              >
                Attach {item.title}
              </button>
            ))}
        </details>
      ) : null}
      <div className="session-controls">
        <h2 className="eyebrow">Session</h2>
        {props.sessionState === "active" ? (
          <button
            onClick={() =>
              void window.vibecab.command("vc.PauseSession", { sessionId: props.sessionId }).then(props.onRefresh)
            }
          >
            Pause
          </button>
        ) : null}
        {props.sessionState === "paused" ? (
          <button
            onClick={() =>
              void window.vibecab.command("vc.ResumeSession", { sessionId: props.sessionId }).then(props.onRefresh)
            }
          >
            Resume
          </button>
        ) : null}
        {props.sessionState !== "ended" ? (
          <button
            onClick={() =>
              void window.vibecab.command("vc.EndSession", { sessionId: props.sessionId }).then(props.onRefresh)
            }
          >
            End
          </button>
        ) : null}
      </div>
    </nav>
  );
}
