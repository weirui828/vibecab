import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "@wei/design-system";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import type { ConnectionState } from "../connection.js";
import { sortSessions } from "../live/workspace.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { attentionSentence } from "../home/attentionText.js";
import { Count } from "../ui/Count.js";
import { Mark } from "../ui/Brand.js";
import { plural } from "../ui/time.js";
import { ConnectionLabel } from "./Navigation.js";
import { navigate } from "./prefs.js";
import type { ThemeChoice } from "./prefs.js";

export interface BarProps {
  route: string;
  /** The page's name beside Home, when the page is not Home. */
  here?: string | undefined;
  sessions: SessionRow[] | undefined;
  drafts: DraftRow[] | undefined;
  attention: Map<string, AttentionItem[]>;
  connection: ConnectionState;
  theme: ThemeChoice;
  setTheme(choice: ThemeChoice): void;
}

const pages: Array<{ path: string; label: string; hint: string }> = [
  { path: "/", label: "Home", hint: `Every ${terms.session.toLowerCase()}, and what needs you` },
  { path: "/needs-you", label: "Needs you", hint: "What is waiting for an answer" },
  { path: "/sessions", label: `${terms.session}s`, hint: "Active, paused and ended" },
  { path: "/drafts", label: `${terms.draft}s`, hint: "All of them, newest first" },
  { path: "/ideas", label: `${terms.idea}s`, hint: "Notes that are not being worked on yet" },
  {
    path: "/projects",
    label: `${terms.project}s`,
    hint: `${terms.session}s and ${terms.idea.toLowerCase()}s that belong together`,
  },
  { path: "/settings", label: "Settings", hint: "Agents, roles, spending, appearance" },
  { path: "/trash", label: "Trash", hint: "What you removed" },
];

/** The page's name for the bar, from its route (sessions and projects name themselves). */
export function pageName(route: string): string | undefined {
  if (route === "/") return undefined;
  if (route === "/sessions/ended") return `${terms.ended} ${terms.session.toLowerCase()}s`;
  return pages.find((p) => p.path !== "/" && (route === p.path || route.startsWith(p.path + "/")))?.label;
}

/** One bar instead of a sidebar: where you are, what needs you, and one box that jumps anywhere. */
export function TopBar({ route, here, sessions, drafts, attention, connection, theme, setTheme }: BarProps) {
  const [needsOpen, setNeedsOpen] = useState(false),
    [jumping, setJumping] = useState(false),
    needs = useRef<HTMLDivElement>(null);
  const waiting = useMemo(
    () => sortSessions(sessions ?? [], attention).filter((s) => (attention.get(s.sessionId)?.length ?? 0) > 0),
    [sessions, attention],
  );
  useEffect(() => {
    setNeedsOpen(false);
    setJumping(false);
  }, [route]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setJumping((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!needsOpen) return;
    const away = (event: PointerEvent) => {
      if (!needs.current?.contains(event.target as Node)) setNeedsOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [needsOpen]);
  const dark =
    theme === "dark" || (theme === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  return (
    <header className="vc-topbar">
      <a className="vc-top-mark" href="#/" aria-label="Home" title="Home">
        <Mark height={22} />
      </a>
      {route === "/" ? (
        <small className="vc-top-tagline">Thinking. Vibing. Building.</small>
      ) : (
        <nav className="vc-crumb" aria-label="You are here">
          <a href="#/">Home</a>
          {here && (
            <>
              <span aria-hidden="true">/</span>
              <b aria-current="page">{here}</b>
            </>
          )}
        </nav>
      )}
      <span className="vc-top-space" />
      {connection !== "Connected" && <ConnectionLabel state={connection} />}
      <div className="vc-needs" ref={needs}>
        <button
          type="button"
          className="vc-top-pill"
          aria-haspopup="true"
          aria-expanded={needsOpen}
          data-waiting={waiting.length > 0 || undefined}
          onClick={() => setNeedsOpen((open) => !open)}
        >
          <i aria-hidden="true" />
          <span className="label">Needs you</span>
          {waiting.length > 0 && <Count value={waiting.length} />}
        </button>
        {needsOpen && (
          <div className="vc-pop" role="group" aria-label="Needs you">
            {waiting.length === 0 && <p className="vc-pop-empty">Everything is answered.</p>}
            {waiting.map((session) => (
              <a key={session.sessionId} href={"#/s/" + session.sessionId}>
                <b>{session.title}</b>
                <span>{attentionSentence(attention.get(session.sessionId) ?? [])}</span>
              </a>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="vc-top-pill vc-jump" onClick={() => setJumping(true)}>
        <span className="label">Jump to…</span>
        <kbd>⌘K</kbd>
      </button>
      <button
        type="button"
        className="vc-top-round"
        aria-label={dark ? "Switch to Summer" : "Switch to Polar night"}
        title={dark ? "Summer" : "Polar night"}
        onClick={() => setTheme(dark ? "light" : "dark")}
      >
        <Icon name={dark ? "sun" : "moon"} size={20} />
      </button>
      <a
        className="vc-top-round"
        href="#/settings"
        aria-label="Settings"
        title="Settings"
        aria-current={route.startsWith("/settings") ? "page" : undefined}
      >
        <Icon name="cog-6-tooth" size={20} />
      </a>
      {jumping && <JumpBox sessions={sessions ?? []} drafts={drafts ?? []} onClose={() => setJumping(false)} />}
    </header>
  );
}

interface Place {
  kind: string;
  label: string;
  hint: string;
  path: string;
}

/** Everything that is not on screen is one jump away: type a few letters, press Enter. */
function JumpBox({ sessions, drafts, onClose }: { sessions: SessionRow[]; drafts: DraftRow[]; onClose(): void }) {
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => before?.focus?.();
  }, []);
  const places = useMemo<Place[]>(() => {
    const open = sessions.filter((s) => s.state !== "ended"),
      ended = sessions.length - open.length,
      byId = new Map(sessions.map((s) => [s.sessionId, s]));
    return [
      ...open.map((s) => ({
        kind: `${terms.session}s`,
        label: s.title,
        hint: s.state === "paused" ? terms.paused : terms.active,
        path: "/s/" + s.sessionId,
      })),
      ...(ended > 0
        ? [
            {
              kind: `${terms.session}s`,
              label: plural(ended, terms.ended.toLowerCase()),
              hint: "Read-only records",
              path: "/sessions/ended",
            },
          ]
        : []),
      ...drafts.flatMap((d) => {
        const home = d.sessionIds.map((id) => byId.get(id)).find((s) => s !== undefined);
        return home
          ? [
              {
                kind: `${terms.draft}s`,
                label: d.title,
                hint: "In " + home.title,
                path: `/s/${home.sessionId}/d/${d.artifactId}`,
              },
            ]
          : [];
      }),
      ...pages.map((p) => ({ kind: "Pages", label: p.label, hint: p.hint, path: p.path })),
    ];
  }, [sessions, drafts]);
  const words = query.trim().toLowerCase(),
    shown = places.filter((p) => !words || (p.label + " " + p.hint).toLowerCase().includes(words)).slice(0, 14),
    go = (place: Place | undefined) => {
      if (!place) return;
      onClose();
      navigate(place.path);
    };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") setActive((i) => Math.min(i + 1, shown.length - 1));
    else if (event.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (event.key === "Enter") go(shown[Math.min(active, shown.length - 1)]);
    else return;
    event.preventDefault();
  };
  let kind = "";
  return (
    <div className="vc-jump-veil" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="vc-jump-box" role="dialog" aria-modal="true" aria-label="Jump to" onKeyDown={onKey}>
        <input
          ref={input}
          type="text"
          aria-label="Jump to"
          placeholder={`A ${terms.session.toLowerCase()}, a ${terms.draft.toLowerCase()}, a page…`}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <div className="vc-jump-list">
          {shown.length === 0 && <p className="vc-pop-empty">Nothing matches.</p>}
          {shown.map((place, i) => {
            const head = place.kind !== kind ? (kind = place.kind) : undefined;
            return (
              <div key={place.path + place.label}>
                {head && <small>{head}</small>}
                <a
                  href={"#" + place.path}
                  data-active={i === active || undefined}
                  onClick={onClose}
                  onPointerEnter={() => setActive(i)}
                >
                  <b>{place.label}</b>
                  <span>{place.hint}</span>
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
