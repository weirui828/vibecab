import { Button } from "@wei/design-system";
import type { VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";

type Draft = VcArtifactsOperation["result"][number];
type Session = VcSessionsOperation["result"][number];

export function HomeView({
  drafts,
  sessions,
  onImprove,
  onExplore,
  onOpenSession,
}: {
  drafts: Draft[];
  sessions: Session[];
  onImprove: () => void;
  onExplore: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const recent = sessions
    .filter((session) => session.state !== "ended")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  return (
    <div className="page home-page">
      <header className="page-header home-heading">
        <div>
          <p className="eyebrow">VibeCab</p>
          <h1 className="page-title">What would you like to do?</h1>
          <p className="meta">Start with a Draft, or bring a few Ideas together.</p>
        </div>
      </header>
      <div className="workflow-choices">
        <section className="workflow-choice">
          <p className="eyebrow">Work on something you have</p>
          <h2>Improve a {terms.draft}</h2>
          <p>
            Choose a {terms.draft}, start a {terms.session}, and collaborate until it feels right.
          </p>
          <Button variant="primary" onClick={onImprove}>
            Choose a {terms.draft.toLowerCase()}
          </Button>
        </section>
        <section className="workflow-choice">
          <p className="eyebrow">Start from a spark</p>
          <h2>Explore {terms.idea}s</h2>
          <p>
            Bring scattered {terms.idea.toLowerCase()}s into a {terms.session}. Grow promising directions into{" "}
            {terms.project}s.
          </p>
          <Button variant="secondary" onClick={onExplore}>
            Browse {terms.idea.toLowerCase()}s
          </Button>
        </section>
      </div>
      {recent.length ? (
        <section className="home-section home-continue">
          <div className="row">
            <h2 className="section-label">Continue a {terms.session}</h2>
          </div>
          <div className="draft-list">
            {recent.map((session) => (
              <button
                key={session.sessionId}
                className="draft-open session-resume-row"
                onClick={() => onOpenSession(session.sessionId)}
              >
                <strong>{session.title}</strong>
                <span className="meta">
                  {session.artifactIds.length}{" "}
                  {session.artifactIds.length === 1 ? terms.draft.toLowerCase() : `${terms.draft.toLowerCase()}s`} ·{" "}
                  {terms[session.state]}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {drafts.length === 0 && sessions.length === 0 ? (
        <p className="home-first-run">
          Your {terms.draft.toLowerCase()}s and {terms.session.toLowerCase()}s will show up here as you work.
        </p>
      ) : null}
    </div>
  );
}
