import { Icon } from "@wei/design-system";
import type { IconName } from "@wei/design-system";
import { plural } from "../ui/time.js";
import { terms } from "../../../ui/src/copy/terms.js";
import type { ConnectionState } from "../../../ui/src/connection.js";
import { sortSessions } from "../live/workspace.js";
import type { SessionRow } from "../live/workspace.js";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { Mark, Mound, Wordmark } from "../ui/Brand.js";
import type { MoundTone } from "../ui/Brand.js";
import { attentionTone } from "../home/attentionText.js";
import type { ThemeChoice } from "./prefs.js";

export interface NavProps {
  route: string;
  sessions: SessionRow[] | undefined;
  attention: Map<string, AttentionItem[]>;
  needsYou: number;
  connection: ConnectionState;
  theme: ThemeChoice;
  setTheme(choice: ThemeChoice): void;
  version: string;
  onNavigate?(): void;
  /** Folds the sidebar to a rail of icons and back; only the main sidebar has it, not the phone sheet. */
  onToggleRail?(): void;
}

/** A panel with its left column: the sidebar, folding (◀) or opening (▶). */
function RailGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9 4.5v15" />
      <path d={open ? "M15.5 10l-2 2 2 2" : "M13.5 10l2 2-2 2"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const primaryNav: Array<{ path: string; label: string; icon: IconName }> = [
  { path: "/", label: "Home", icon: "home" },
  { path: "/needs-you", label: "Needs you", icon: "bell" },
  { path: "/drafts", label: `${terms.draft}s`, icon: "document-text" },
  { path: "/ideas", label: `${terms.idea}s`, icon: "pencil" },
  { path: "/projects", label: `${terms.project}s`, icon: "briefcase" },
];

export function sessionTone(session: SessionRow, items: AttentionItem[] | undefined): MoundTone {
  if (session.state !== "active") return "quiet";
  if (items?.length) return attentionTone(items);
  return "active";
}

export function ConnectionLabel({ state }: { state: ConnectionState }) {
  const tone: MoundTone = state === "Connected" ? "active" : state === "Starting" ? "agent" : "danger";
  return (
    <span className="vc-connection" title={state}>
      <Mound tone={tone} />
      <span className="label">{state === "Connected" ? "Connected" : state}</span>
    </span>
  );
}

export function ThemeSwitch({
  theme,
  setTheme,
  small,
}: {
  theme: ThemeChoice;
  setTheme(t: ThemeChoice): void;
  small?: boolean;
}) {
  const options: Array<[ThemeChoice, string]> = [
    ["auto", "Auto"],
    ["light", "Summer"],
    ["dark", "Polar night"],
  ];
  return (
    <div className={"vc-segmented" + (small ? " small" : "")} role="group" aria-label="Theme">
      {options.map(([value, label]) => (
        <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const isCurrent = (route: string, path: string) =>
  path === "/" ? route === "/" : route.startsWith(path) || (path === "/projects" && route.startsWith("/p/"));

/** A quiet sidebar for navigation only. */
export function Sidebar(props: NavProps) {
  const { route, sessions, attention, needsYou, connection, onNavigate, onToggleRail } = props;
  const open = sortSessions(sessions ?? [], attention).filter((s) => s.state !== "ended"),
    ended = (sessions ?? []).length - open.length;
  return (
    <aside className="vc-sidebar" aria-label="Navigation">
      <a className="vc-rail-mark" href="#/" aria-label="Home">
        <Mark height={20} />
      </a>
      <a className="vc-sidebar-brand collapsible" href="#/" onClick={onNavigate}>
        <Wordmark height={30} />
        <small>Thinking. Vibing. Building.</small>
      </a>
      <nav className="vc-nav" aria-label="Main">
        {primaryNav.map((item) => {
          const count = item.path === "/needs-you" ? needsYou : 0;
          return (
            <a
              key={item.path}
              className="vc-nav-link"
              href={"#" + item.path}
              title={item.label}
              aria-current={isCurrent(route, item.path) ? "page" : undefined}
              data-attention={count > 0}
              onClick={onNavigate}
            >
              <Icon name={item.icon} size={20} />
              <span className="label">{item.label}</span>
              {count > 0 && <span className="count">{count}</span>}
            </a>
          );
        })}
      </nav>
      {(sessions ?? []).length > 0 && (
        <div className="collapsible">
          <div className="vc-nav-section">
            <a
              className="vc-label vc-nav-heading"
              href="#/sessions"
              onClick={onNavigate}
              aria-current={route === "/sessions" ? "page" : undefined}
            >
              {terms.session}s
            </a>
          </div>
          <nav className="vc-nav" aria-label={`${terms.session}s`}>
            {open.map((session) => {
              const items = attention.get(session.sessionId);
              return (
                <a
                  key={session.sessionId}
                  className="vc-session-link"
                  href={"#/s/" + session.sessionId}
                  data-state={session.state}
                  aria-current={
                    route === "/s/" + session.sessionId || route.startsWith("/s/" + session.sessionId + "/")
                      ? "page"
                      : undefined
                  }
                  onClick={onNavigate}
                >
                  <Mound tone={sessionTone(session, items)} />
                  <span className="title">{session.title}</span>
                  {items && items.length > 0 && <span className="count">{items.length}</span>}
                </a>
              );
            })}
          </nav>
          {ended > 0 && (
            <a className="vc-nav-more" href="#/sessions/ended" onClick={onNavigate}>
              {plural(ended, terms.ended.toLowerCase())}
            </a>
          )}
        </div>
      )}
      <div className="vc-sidebar-foot">
        {/* Only Settings and Trash live here: the theme and version are in Settings. The connection shows only when
            something is wrong, since then Settings cannot load. */}
        {connection !== "Connected" && (
          <span className="collapsible">
            <ConnectionLabel state={connection} />
          </span>
        )}
        <div className="vc-foot-links collapsible">
          <a href="#/settings" onClick={onNavigate}>
            Settings
          </a>
          <a href="#/trash" onClick={onNavigate}>
            Trash
          </a>
          {onToggleRail && (
            <button
              type="button"
              className="vc-rail-toggle"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              onClick={onToggleRail}
            >
              <RailGlyph open />
            </button>
          )}
        </div>
        <nav className="vc-nav rail-only" aria-label="More">
          <a className="vc-nav-link" href="#/trash" title="Trash" aria-label="Trash">
            <Icon name="trash" size={20} />
          </a>
          <a className="vc-nav-link" href="#/settings" title="Settings" aria-label="Settings">
            <Icon name="cog-6-tooth" size={20} />
          </a>
          {onToggleRail && (
            <button
              type="button"
              className="vc-nav-link vc-rail-expand"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              onClick={onToggleRail}
            >
              <RailGlyph open={false} />
            </button>
          )}
        </nav>
      </div>
    </aside>
  );
}
