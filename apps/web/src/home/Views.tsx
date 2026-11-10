import { useState } from "react";
import { Button, Icon, Input } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { sortSessions } from "../live/workspace.js";
import type { useWorkspace } from "../live/workspace.js";
import { Hills } from "../ui/Brand.js";
import { Horizon } from "../ui/Horizon.js";
import { greeting, plural } from "../ui/time.js";
import { AttentionRows, DraftRows, SessionRows } from "./Rows.js";
import { useDialogs } from "./DialogHost.js";

type Workspace = ReturnType<typeof useWorkspace>;

const byNewest = <T extends { createdAt: string }>(a: T, b: T) => b.createdAt.localeCompare(a.createdAt);

export function HomeView({ workspace }: { workspace: Workspace }) {
  const dialogs = useDialogs(),
    [showEnded, setShowEnded] = useState(false);
  const sessions = sortSessions(workspace.sessions ?? [], workspace.attention),
    drafts = [...(workspace.drafts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    waiting = sessions.filter((s) => (workspace.attention.get(s.sessionId)?.length ?? 0) > 0);
  if (workspace.loading && !workspace.sessions) return <PageSkeleton />;
  if (sessions.length === 0 && drafts.length === 0) return <EmptyHome />;
  const live = sessions.filter((s) => s.state !== "ended"),
    ended = sessions.filter((s) => s.state === "ended");
  const facts = [
    plural(live.length, terms.session.toLowerCase()),
    plural(drafts.length, terms.draft),
    waiting.length ? `${waiting.length} need${waiting.length === 1 ? "s" : ""} you` : "nothing waiting",
  ].join(" · ");
  return (
    <div className="vc-page">
      <header className="vc-header with-horizon">
        <Horizon />
        <h1 className="vc-display">{greeting()}</h1>
        <p className="vc-facts">{facts}</p>
        <div className="vc-actions">
          <Button variant="primary" leadingIcon={<Icon name="plus" />} onClick={() => dialogs.newDraft()}>
            New {terms.draft.toLowerCase()}
          </Button>
          <Button variant="ghost" onClick={dialogs.newSession}>
            New {terms.session.toLowerCase()}
          </Button>
        </div>
      </header>

      {waiting.length > 0 && (
        <section className="vc-section" aria-labelledby="needs-you">
          <div className="vc-section-head">
            <h2 className="vc-label" id="needs-you">
              Needs you
            </h2>
            {waiting.length > 4 && (
              <a className="vc-link-button" href="#/needs-you">
                All {waiting.length}
              </a>
            )}
          </div>
          <AttentionRows sessions={waiting} attention={workspace.attention} limit={4} />
        </section>
      )}

      {sessions.length > 0 && (
        <section className="vc-section" aria-labelledby="sessions">
          <div className="vc-section-head">
            <h2 className="vc-label" id="sessions">
              {terms.session}s
            </h2>
            {ended.length > 0 && (
              <button type="button" className="vc-link-button" onClick={() => setShowEnded((v) => !v)}>
                {showEnded ? "Hide ended" : `Show ended (${ended.length})`}
              </button>
            )}
          </div>
          <SessionRows
            sessions={showEnded ? [...live, ...ended] : live}
            drafts={drafts}
            attention={workspace.attention}
          />
        </section>
      )}

      {drafts.length > 0 && (
        <section className="vc-section" aria-labelledby="drafts">
          <div className="vc-section-head">
            <h2 className="vc-label" id="drafts">
              Recent {terms.draft.toLowerCase()}s
            </h2>
            {drafts.length > 5 && (
              <a className="vc-link-button" href="#/drafts">
                All {drafts.length}
              </a>
            )}
          </div>
          <DraftRows drafts={drafts.slice(0, 5)} sessions={sessions} />
        </section>
      )}
    </div>
  );
}

export function EmptyHome() {
  const dialogs = useDialogs();
  return (
    <div className="vc-page">
      <div className="vc-empty">
        <Hills />
        <h1 className="vc-display">Nothing drafted yet.</h1>
        <p>
          Start a {terms.draft.toLowerCase()}, leave comments where it feels off, and let the agent do the rewriting.
        </p>
        <Button variant="primary" size="lg" leadingIcon={<Icon name="plus" />} onClick={() => dialogs.newDraft()}>
          New {terms.draft.toLowerCase()}
        </Button>
        <ol className="vc-steps">
          <li>
            <b>1</b>Start a {terms.draft.toLowerCase()}
          </li>
          <li>
            <b>2</b>Comment on text that is not correct
          </li>
          <li>
            <b>3</b>
            {terms.agree}, and the agent updates it
          </li>
        </ol>
      </div>
    </div>
  );
}

export function NeedsYouView({ workspace }: { workspace: Workspace }) {
  const sessions = [...(workspace.sessions ?? [])].sort(byNewest),
    waiting = sessions.filter((s) => (workspace.attention.get(s.sessionId)?.length ?? 0) > 0);
  if (workspace.loading && !workspace.sessions) return <PageSkeleton />;
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">Needs you</h1>
        <p className="vc-facts">
          {waiting.length
            ? `${plural(waiting.length, terms.session.toLowerCase())} waiting`
            : "Everything is answered."}
        </p>
      </header>
      {waiting.length > 0 && (
        <section className="vc-section" aria-label="Waiting">
          <AttentionRows sessions={waiting} attention={workspace.attention} />
        </section>
      )}
    </div>
  );
}

export function DraftsView({ workspace }: { workspace: Workspace }) {
  const dialogs = useDialogs(),
    [filter, setFilter] = useState("");
  const drafts = [...(workspace.drafts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    shown = drafts.filter((d) => d.title.toLowerCase().includes(filter.trim().toLowerCase()));
  if (workspace.loading && !workspace.drafts) return <PageSkeleton />;
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">{terms.draft}s</h1>
        <p className="vc-facts">{plural(drafts.length, terms.draft)} · newest first</p>
        <div className="vc-actions">
          <Button variant="primary" leadingIcon={<Icon name="plus" />} onClick={() => dialogs.newDraft()}>
            New {terms.draft.toLowerCase()}
          </Button>
        </div>
      </header>
      <section className="vc-section" aria-label={`${terms.draft}s`}>
        {drafts.length > 8 && (
          <div className="vc-search">
            <Input
              inputSize="sm"
              placeholder="Filter by title"
              aria-label="Filter by title"
              prefix={<Icon name="magnifying-glass" />}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        )}
        {shown.length > 0 ? (
          <DraftRows drafts={shown} sessions={workspace.sessions ?? []} />
        ) : (
          <p className="vc-muted">{drafts.length ? "Nothing matches." : `No ${terms.draft.toLowerCase()}s yet.`}</p>
        )}
      </section>
    </div>
  );
}

/** Screens that arrive in later tasks: honest, calm, with a way back. */
export function LaterView({ title, line }: { title: string; line: string }) {
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">{title}</h1>
        <p className="vc-facts">{line}</p>
        <div className="vc-actions">
          <Button variant="ghost" leadingIcon={<Icon name="arrow-left" />} onClick={() => (window.location.hash = "/")}>
            Home
          </Button>
        </div>
      </header>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="vc-page" aria-busy="true" aria-label="Loading">
      <div className="vc-skeleton-line" style={{ width: "46%", height: 40 }} />
      <div className="vc-skeleton-line" style={{ width: "30%", marginTop: 16 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="vc-skeleton-line" style={{ width: `${80 - i * 12}%`, marginTop: i === 0 ? 72 : 22 }} />
      ))}
    </div>
  );
}
