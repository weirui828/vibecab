import { Icon } from "@wei/design-system";
import type { IconName } from "@wei/design-system";
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
}

export const primaryNav: Array<{ path: string; label: string; icon: IconName }> = [
  { path: "/", label: "Home", icon: "home" },
  { path: "/needs-you", label: "Needs you", icon: "bell" },
  { path: "/drafts", label: `${terms.draft}s`, icon: "document-text" },
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

const isCurrent = (route: string, path: string) => (path === "/" ? route === "/" : route.startsWith(path));

/** A quiet sidebar for navigation only. */
export function Sidebar(props: NavProps) {
  const { route, sessions, attention, needsYou, connection, theme, setTheme, version, onNavigate } = props;
  const open = sortSessions(sessions ?? [], attention).filter((s) => s.state !== "ended");
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
      {open.length > 0 && (
        <div className="collapsible">
          <div className="vc-nav-section">
            <p className="vc-label">{terms.session}s</p>
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
                  aria-current={route === "/s/" + session.sessionId ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <Mound tone={sessionTone(session, items)} />
                  <span className="title">{session.title}</span>
                  {items && items.length > 0 && <span className="count">{items.length}</span>}
                </a>
              );
            })}
          </nav>
        </div>
      )}
      <div className="vc-sidebar-foot">
        <span className="collapsible">
          <ConnectionLabel state={connection} />
        </span>
        <span className="collapsible">
          <ThemeSwitch theme={theme} setTheme={setTheme} small />
        </span>
        <div className="vc-foot-links collapsible">
          <a href="#/settings" onClick={onNavigate}>
            Settings
          </a>
          <a href="#/trash" onClick={onNavigate}>
            Trash
          </a>
          <span className="vc-facts" style={{ marginLeft: "auto", fontSize: 11 }}>
            v{version}
          </span>
        </div>
        <nav className="vc-nav rail-only" aria-label="More">
          <a className="vc-nav-link" href="#/trash" title="Trash" aria-label="Trash">
            <Icon name="trash" size={20} />
          </a>
          <a className="vc-nav-link" href="#/settings" title="Settings" aria-label="Settings">
            <Icon name="cog-6-tooth" size={20} />
          </a>
        </nav>
      </div>
    </aside>
  );
}
