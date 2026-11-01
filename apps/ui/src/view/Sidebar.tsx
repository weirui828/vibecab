import type { VcSessionsOperation } from "../../../../contract/generated/index.js";
import { Button } from "@wei/design-system";
import { terms } from "../copy/terms.js";
import { startSession } from "../api/sessions.js";
import type { ConnectionState } from "../connection.js";
import { Mark, Mound, Wordmark } from "./Brand.js";

type Theme = "system" | "light" | "dark";

export function Sidebar({
  artifactsCount,
  ideasCount,
  projectsCount,
  sessions,
  activeSessionId,
  route,
  state,
  theme,
  setTheme,
  needsYou,
  onSelectNone,
  onNavigate,
  onConnected,
  onRefresh,
  onError,
  onTrashed,
  onRename,
  collapsed,
  onToggleCollapsed,
}: {
  artifactsCount: number;
  ideasCount: number;
  projectsCount: number;
  sessions: VcSessionsOperation["result"];
  activeSessionId?: string;
  route: string;
  state: ConnectionState;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  needsYou: (sessionId: string) => number;
  onSelectNone: () => void;
  onNavigate: (path: string) => void;
  onConnected: () => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onTrashed: (target: { kind: "artifact" | "session"; id: string }, reviewCount: number) => void;
  onRename: (sessionId: string, title: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  if (collapsed)
    return (
      <aside className="sidebar is-collapsed" aria-label="Main navigation">
        <div className="collapsed-brand" aria-hidden="true">
          <Mark width={30} />
        </div>
        <button
          className="sidebar-toggle collapsed-sidebar-toggle"
          aria-label="Expand main navigation"
          title="Expand sidebar"
          onClick={onToggleCollapsed}
        >
          ›
        </button>
      </aside>
    );
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand">
        <Wordmark width={168} />
        <p className="tagline">Thinking. Vibing. Building.</p>
      </div>
      <nav className="sidebar-nav" aria-label="Your work">
        <button className="nav-link" aria-current={route === "/" ? "page" : undefined} onClick={() => onNavigate("/")}>
          Home
        </button>
        <button
          className="nav-link"
          aria-current={route === "/ideas" ? "page" : undefined}
          onClick={() => onNavigate("/ideas")}
        >
          {terms.idea}s <span className="count">{ideasCount}</span>
        </button>
        <button
          className="nav-link"
          aria-current={route === "/projects" ? "page" : undefined}
          onClick={() => onNavigate("/projects")}
        >
          {terms.project}s <span className="count">{projectsCount}</span>
        </button>
        <button
          className="nav-link"
          aria-current={route === "/drafts" ? "page" : undefined}
          onClick={() => onNavigate("/drafts")}
        >
          {terms.draft}s <span className="count">{artifactsCount}</span>
        </button>
      </nav>
      <div className="sidebar-sessions">
        <div className="row">
          <button
            className="eyebrow sidebar-session-heading"
            aria-current={route === "/sessions" ? "page" : undefined}
            onClick={() => onNavigate("/sessions")}
          >
            {terms.session}s
          </button>
          <button
            className="icon-button"
            aria-label={`New ${terms.session.toLowerCase()}`}
            onClick={() =>
              void startSession("New session")
                .then(async ({ sessionId }) => {
                  await onRefresh();
                  window.location.hash = "/s/" + encodeURIComponent(sessionId);
                })
                .catch((failure) => onError(String(failure)))
            }
          >
            +
          </button>
        </div>
        {sessions.map((session) => {
          const waiting = needsYou(session.sessionId);
          return (
            <div
              key={session.sessionId}
              className="session-nav-item"
              aria-current={activeSessionId === session.sessionId ? "page" : undefined}
            >
              <button
                className="session-link"
                onClick={() => {
                  onSelectNone();
                  window.location.hash = "/s/" + encodeURIComponent(session.sessionId);
                }}
              >
                <Mound tone={session.state !== "active" ? "quiet" : waiting ? "attention" : "active"} />
                <span className="session-link-title">{session.title}</span>
                <small className="meta">
                  {terms[session.state]} · {waiting} {waiting === 1 ? "item" : "items"} need{waiting === 1 ? "s" : ""}{" "}
                  you
                </small>
              </button>
              <span className="session-link-actions">
                <button
                  className="quiet-action"
                  aria-label={`Rename ${session.title}`}
                  onClick={() => onRename(session.sessionId, session.title)}
                >
                  Rename
                </button>
                <button
                  className="quiet-action"
                  aria-label={`Move ${session.title} to trash`}
                  onClick={() => {
                    const target = { kind: "session" as const, id: session.sessionId };
                    void window.vibecab
                      .query<{ reviewRuns: unknown[] }>("vc.PurgePreview", { target })
                      .then((preview) =>
                        window.vibecab.command("vc.Trash", { target }).then((result) => ({ preview, result })),
                      )
                      .then(async ({ preview, result }) => {
                        if (!result.ok) return;
                        onTrashed(target, preview.reviewRuns.length);
                        await onRefresh();
                      });
                  }}
                >
                  Trash
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <footer className="sidebar-footer">
        <p className="connection">
          <Mound tone={state === "Connected" ? "active" : state === "Starting" ? "agent" : "danger"} />
          <span>{state}</span>
        </p>
        {state === "Engine stopped" || state === "Engine unreachable" ? (
          <Button size="sm" onClick={() => void window.vibecab.app.startEngine().then(onConnected)}>
            Start engine
          </Button>
        ) : null}
        <div className="segmented" role="group" aria-label="Theme">
          {(
            [
              ["system", "Auto"],
              ["light", "Summer"],
              ["dark", "Polar night"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={theme === value}
              onClick={() => {
                setTheme(value);
                void window.vibecab.app.setTheme(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="footer-links">
          <button onClick={() => onNavigate("/help")}>{terms.help}</button>
          <span aria-hidden="true"> · </span>
          <button
            onClick={() => {
              onNavigate("/settings");
            }}
          >
            Settings
          </button>
          <span aria-hidden="true"> · </span>
          <button
            onClick={() => {
              onNavigate("/trash");
            }}
          >
            Trash
          </button>
        </p>
        <button className="sidebar-toggle" aria-label="Collapse main navigation" onClick={onToggleCollapsed}>
          <span aria-hidden="true">‹</span>
          Collapse sidebar
        </button>
      </footer>
    </aside>
  );
}
