import { Button } from "@wei/design-system";
import type { AttentionItem, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import { Hills, Mound } from "./Brand.js";

type Draft = VcArtifactsOperation["result"][number];
type Session = VcSessionsOperation["result"][number];

export function DraftsView(props: {
  artifacts: Draft[];
  filteredArtifacts: Draft[];
  sessions: Session[];
  groupedAttention: Map<string, AttentionItem[]>;
  filter: string;
  setFilter: (value: string) => void;
  showNewDraft: boolean;
  setShowNewDraft: (value: boolean) => void;
  draftSessionId: string;
  setDraftSessionId: (value: string) => void;
  error: string;
  homeMeta: string;
  undoTarget?: { kind: "artifact" | "session"; id: string; reviewCount: number };
  onCreateDraft: () => void;
  onImport: () => void;
  onNewSession: () => void;
  onOpenArtifact: (artifactId: string) => void;
  onRename: (draft: Draft) => void;
  onTrash: (artifactId: string) => void;
  onUndo: () => void;
}) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Your work</p>
          <h1 className="page-title">{terms.draft}s</h1>
          <p className="meta">{props.homeMeta}</p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={props.onNewSession}>
            New {terms.session.toLowerCase()}
          </Button>
          <Button variant="primary" onClick={() => props.setShowNewDraft(!props.showNewDraft)}>
            New {terms.draft.toLowerCase()}
          </Button>
        </div>
      </header>
      {props.showNewDraft ? (
        <section className="panel new-draft" aria-label={`New ${terms.draft.toLowerCase()}`}>
          <p className="eyebrow">New {terms.draft.toLowerCase()}</p>
          <div className="new-draft-row">
            <label className="field">
              <span>Session (optional)</span>
              <select
                aria-label="Session (optional)"
                value={props.draftSessionId}
                onChange={(event) => props.setDraftSessionId(event.target.value)}
              >
                <option value="none">Keep on its own</option>
                <option value="new">Start a Session now</option>
                {props.sessions
                  .filter((session) => session.state !== "ended")
                  .map((session) => (
                    <option key={session.sessionId} value={session.sessionId}>
                      {session.title}
                    </option>
                  ))}
              </select>
            </label>
            <Button variant="primary" onClick={props.onCreateDraft}>
              Blank {terms.document}
            </Button>
            <Button variant="secondary" onClick={props.onImport}>
              Import Markdown
            </Button>
          </div>
        </section>
      ) : null}
      {props.error ? (
        <p role="alert" className="notice">
          {props.error}
        </p>
      ) : null}
      {props.artifacts.length === 0 ? (
        <section className="empty-state" aria-label={`No ${terms.draft.toLowerCase()}s yet`}>
          <Hills />
          <h2 className="empty-title">Start with a Draft</h2>
          <p>Create a standalone Draft or start a Session as you create it.</p>
          <Button variant="primary" onClick={() => props.setShowNewDraft(true)}>
            New Draft
          </Button>
        </section>
      ) : (
        <>
          <section className="home-section" aria-label="Needs you">
            <h2 className="section-label">Needs you</h2>
            {props.groupedAttention.size ? (
              <div className="attention-grid">
                {Array.from(props.groupedAttention, ([group, items]) => (
                  <div key={group} className="attention-card">
                    <h3>
                      <Mound tone="attention" />{" "}
                      {props.sessions.find((session) => session.sessionId === group)?.title ?? "General"}
                    </h3>
                    <div className="chips">
                      {items.map((item) => (
                        <button
                          className="chip"
                          key={item.kind + item.id}
                          onClick={() =>
                            item.sessionId && (window.location.hash = "/s/" + encodeURIComponent(item.sessionId))
                          }
                        >
                          {attentionLabel(item.kind)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="quiet">No items need your attention.</p>
            )}
          </section>
          <section className="home-section" aria-label={`${terms.draft}s`}>
            <div className="row">
              <h2 className="section-label">All {terms.draft.toLowerCase()}s</h2>
              <label className="search">
                <span className="visually-hidden">Filter Drafts</span>
                <input
                  aria-label="Filter Drafts"
                  placeholder="Filter Drafts"
                  value={props.filter}
                  onChange={(event) => props.setFilter(event.target.value)}
                />
              </label>
            </div>
            <div className="draft-list">
              {props.filteredArtifacts.map((draft) => (
                <article className="draft-row" key={draft.artifactId}>
                  <button className="draft-open" onClick={() => props.onOpenArtifact(draft.artifactId)}>
                    <strong>{draft.title}</strong>
                    <span className="meta">
                      {terms.document} · v{draft.headVersion} · updated {relativeDay(draft.updatedAt)}
                    </span>
                  </button>
                  <div className="draft-actions">
                    <button className="quiet-action" onClick={() => props.onRename(draft)}>
                      Rename
                    </button>
                    <button className="quiet-action" onClick={() => props.onTrash(draft.artifactId)}>
                      Move to trash
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
      {props.undoTarget ? (
        <p role="status" className="toast">
          Moved to Trash.{" "}
          {props.undoTarget.reviewCount > 0
            ? `${props.undoTarget.reviewCount} dependent reviews will be handled when purged. `
            : null}
          <button onClick={props.onUndo}>Undo</button>
        </p>
      ) : null}
    </div>
  );
}

function attentionLabel(kind: AttentionItem["kind"]): string {
  const labels: Record<AttentionItem["kind"], string> = {
    conflict: "Conflict to resolve",
    agreed_item: "Agreed, waiting for an Update",
    unread_reply: "Unread reply",
    proposal: "Proposal to review",
    new_version: "New version",
    running_update: "Update running",
    failed_update: "Update failed",
    output_set: "New Snapshot",
  };
  return labels[kind];
}

function relativeDay(timestamp: string): string {
  const days = Math.round((Date.parse(timestamp) - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(days, "day");
}
