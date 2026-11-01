import { useId, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import type { DiffResult, OutputSet } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
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
  const arrowId = `session-arrow-${useId().replaceAll(":", "")}`;
  const pauseSession = () =>
    void window.vibecab.command("vc.PauseSession", { sessionId: props.sessionId }).then(props.onRefresh);
  const resumeSession = () =>
    void window.vibecab.command("vc.ResumeSession", { sessionId: props.sessionId }).then(props.onRefresh);
  const endSession = () => {
    if (window.confirm("End this Session? It can’t be resumed afterward.")) {
      void window.vibecab.command("vc.EndSession", { sessionId: props.sessionId }).then(props.onRefresh);
    }
  };
  const activateWithKeyboard = (event: KeyboardEvent<SVGGElement>, action: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

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
        <h2 className="eyebrow">{terms.session}</h2>
        <svg
          className="session-state-diagram"
          viewBox="0 0 190 145"
          role="group"
          aria-label={`Session lifecycle. Current state: ${terms[props.sessionState]}.`}
        >
          <defs>
            <marker id={arrowId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0 0 L6 3 L0 6 Z" />
            </marker>
          </defs>
          <g
            className="session-transition-button"
            data-disabled={props.sessionState !== "active"}
            role="button"
            aria-label="Pause Session"
            aria-disabled={props.sessionState !== "active"}
            tabIndex={props.sessionState === "active" ? 0 : -1}
            onClick={() => props.sessionState === "active" && pauseSession()}
            onKeyDown={(event) =>
              activateWithKeyboard(event, () => {
                if (props.sessionState === "active") pauseSession();
              })
            }
          >
            <path className="session-transition-hit" d="M30 34 C3 43 3 94 30 105" />
            <path className="session-transition" d="M30 34 C3 43 3 94 30 105" markerEnd={`url(#${arrowId})`} />
            <text className="session-transition-label" x="12" y="70">
              Pause
            </text>
          </g>
          <g
            className="session-transition-button"
            data-disabled={props.sessionState !== "paused"}
            role="button"
            aria-label="Resume Session"
            aria-disabled={props.sessionState !== "paused"}
            tabIndex={props.sessionState === "paused" ? 0 : -1}
            onClick={() => props.sessionState === "paused" && resumeSession()}
            onKeyDown={(event) =>
              activateWithKeyboard(event, () => {
                if (props.sessionState === "paused") resumeSession();
              })
            }
          >
            <path className="session-transition-hit" d="M48 105 C75 94 75 43 48 34" />
            <path className="session-transition" d="M48 105 C75 94 75 43 48 34" markerEnd={`url(#${arrowId})`} />
            <text className="session-transition-label" x="67" y="70">
              Resume
            </text>
          </g>
          <g
            className="session-transition-button"
            data-disabled={props.sessionState !== "active"}
            role="button"
            aria-label="End Session from Active"
            aria-disabled={props.sessionState !== "active"}
            tabIndex={props.sessionState === "active" ? 0 : -1}
            onClick={() => props.sessionState === "active" && endSession()}
            onKeyDown={(event) =>
              activateWithKeyboard(event, () => {
                if (props.sessionState === "active") endSession();
              })
            }
          >
            <path className="session-transition-hit" d="M53 27 C83 2 109 11 133 54" />
            <path className="session-transition" d="M53 27 C83 2 109 11 133 54" markerEnd={`url(#${arrowId})`} />
            <text className="session-transition-label" x="94" y="15">
              End
            </text>
          </g>
          <g
            className="session-transition-button"
            data-disabled={props.sessionState !== "paused"}
            role="button"
            aria-label="End Session from Paused"
            aria-disabled={props.sessionState !== "paused"}
            tabIndex={props.sessionState === "paused" ? 0 : -1}
            onClick={() => props.sessionState === "paused" && endSession()}
            onKeyDown={(event) =>
              activateWithKeyboard(event, () => {
                if (props.sessionState === "paused") endSession();
              })
            }
          >
            <path className="session-transition-hit" d="M53 112 C83 137 109 127 133 76" />
            <path className="session-transition" d="M53 112 C83 137 109 127 133 76" markerEnd={`url(#${arrowId})`} />
            <text className="session-transition-label" x="94" y="139">
              End
            </text>
          </g>
          {(
            [
              { state: "active", x: 40, y: 25 },
              { state: "paused", x: 40, y: 114 },
              { state: "ended", x: 149, y: 65 },
            ] as const
          ).map(({ state, x, y }) => (
            <g
              key={state}
              className="session-state-node"
              data-current={props.sessionState === state}
              data-state={state}
              role="img"
              aria-label={terms[state]}
            >
              <title>{terms[state]}</title>
              <circle className="session-state-current-ring" cx={x} cy={y} r="12" />
              <circle className="session-state-dot" cx={x} cy={y} r="8" />
            </g>
          ))}
        </svg>
      </div>
    </nav>
  );
}
