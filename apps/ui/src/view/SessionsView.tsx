import type { VcSessionsOperation } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";

type Session = VcSessionsOperation["result"][number];

export function SessionsView({ sessions, onOpen }: { sessions: Session[]; onOpen: (sessionId: string) => void }) {
  const projects = sessions.filter((session) => session.projectIds?.length);
  const standalone = sessions.filter((session) => !session.projectIds?.length);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Keep going or look back</p>
          <h1 className="page-title">{terms.session}s</h1>
          <p className="meta">Sessions can stand alone or be organized in Projects.</p>
        </div>
      </header>
      <SessionGroup title="In Projects" sessions={projects} onOpen={onOpen} />
      <SessionGroup title="On their own" sessions={standalone} onOpen={onOpen} />
    </div>
  );
}

function SessionGroup({
  title,
  sessions,
  onOpen,
}: {
  title: string;
  sessions: Session[];
  onOpen: (sessionId: string) => void;
}) {
  return (
    <section className="home-section session-group">
      <h2 className="section-label">{title}</h2>
      {sessions.length ? (
        <div className="draft-list">
          {sessions.map((session) => (
            <button key={session.sessionId} className="draft-open" onClick={() => onOpen(session.sessionId)}>
              <strong>{session.title}</strong>
              <span className="meta">
                {session.artifactIds.length}{" "}
                {session.artifactIds.length === 1 ? terms.draft.toLowerCase() : `${terms.draft.toLowerCase()}s`} ·{" "}
                {terms[session.state]}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="quiet">No Sessions here yet.</p>
      )}
    </section>
  );
}
