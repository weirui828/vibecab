import type { VcSessionsOperation } from "../../../../contract/generated/index.js";
import { Button } from "@wei/design-system";
import { terms } from "../copy/terms.js";
import { startSession } from "../api/sessions.js";
import type { ConnectionState } from "../connection.js";
import { Mark, Mound, Wordmark } from "./Brand.js";

type Theme = "system" | "light" | "dark";

export function Sidebar({
  artifactsCount,
  sessions,
  activeSessionId,
  onHome,
  state,
  theme,
  setTheme,
  needsYou,
  onSelectNone,
  onConnected,
  onRefresh,
  onError,
  onTrashed,
  onRename,
  collapsed,
  onToggleCollapsed,
}: {
  artifactsCount: number;
  sessions: VcSessionsOperation["result"];
  activeSessionId?: string;
  onHome: boolean;
  state: ConnectionState;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  needsYou: (sessionId: string) => number;
  onSelectNone: () => void;
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
      <aside className="sidebar is-collapsed" aria-label="Workspace sidebar">
        <button
          className="collapsed-brand"
          aria-label="Expand workspace sidebar"
          title="Expand sidebar"
          onClick={onToggleCollapsed}
        >
          <Mark width={30} />
          <span aria-hidden="true">›</span>
        </button>
      </aside>
    );
  return (
    <aside className="sidebar" aria-label="Workspace sidebar">
      <div className="sidebar-brand">
        <Wordmark width={168} />
        <p className="tagline">Thinking. Vibing. Building.</p>
        <button
          className="sidebar-toggle"
          aria-label="Collapse workspace sidebar"
          title="Collapse sidebar"
          onClick={onToggleCollapsed}
        >
          ‹
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="Workspace">
        <p className="eyebrow">Workspace</p>
        <button
          className="nav-link"
          aria-current={onHome ? "page" : undefined}
          onClick={() => {
            onSelectNone();
            window.location.hash = "/";
          }}
        >
          {terms.draft}s <span className="count">{artifactsCount}</span>
        </button>
      </nav>
      <div className="sidebar-sessions">
        <div className="row">
          <p className="eyebrow">{terms.session}s</p>
          <button
            className="icon-button"
            aria-label={`New ${terms.session.toLowerCase()}`}
            onClick={() =>
              void startSession("New session")
                .then(onRefresh)
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
                  {session.state} · {waiting} needs you
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
          <button
            onClick={() => {
              window.location.hash = "/settings";
            }}
          >
            Settings
          </button>
          <span aria-hidden="true"> · </span>
          <button
            onClick={() => {
              window.location.hash = "/trash";
            }}
          >
            Trash
          </button>
        </p>
      </footer>
    </aside>
  );
}
