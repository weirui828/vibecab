import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Icon } from "@wei/design-system";
import type { ThreadFilter } from "./threads.js";
import { defaultFilter } from "./threads.js";
import { plural } from "../ui/time.js";
import type { SessionAgent } from "./loop.js";
import type { CommentPlace } from "../shell/prefs.js";

// Outline glyphs in the design system's style (24px grid, 1.5 stroke, currentColor) for what it does not ship.
function Glyph({ d }: { d: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const bubble =
  "M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6l-4.5 4v-4h0A2.5 2.5 0 0 1 4.5 13.5v-7Z";
const margin = "M4.5 5.5h15v13h-15zM14.5 5.5v13";
const bookmark = "M7 4.5h10v15.5l-5-3.6-5 3.6z";
const spark =
  "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1-5.1-1.9 5.1-1.9zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z";

export type ReplyMode = "realtime" | "batch" | "manual";

function AgentPanel({
  mode,
  modelReady,
  onMode,
  onAsk,
  agents,
  agent,
  onAgent,
}: {
  mode: ReplyMode;
  modelReady: boolean;
  onMode(mode: ReplyMode): void;
  onAsk(): void;
  agents: Array<{ id: SessionAgent; name: string }>;
  agent: SessionAgent | undefined;
  onAgent(agent: SessionAgent): void;
}) {
  const name = agents.find((a) => a.id === agent)?.name ?? "The agent";
  const options: Array<[ReplyMode, string, string]> = [
    ["realtime", "Realtime", "The agent replies a moment after each comment."],
    ["batch", "Batch", "The agent replies after some comments, or when there are no new comments for some minutes."],
    ["manual", "Manual", "The agent replies when you ask."],
  ];
  return (
    <div className="vc-filter vc-agent-panel" role="dialog" aria-label="Agent">
      {modelReady ? (
        <>
          {agents.length > 1 && (
            <>
              <p className="vc-label">Who replies</p>
              <div className="vc-segmented small" role="group" aria-label="Who replies">
                {agents.map((a) => (
                  <button key={a.id} type="button" aria-pressed={agent === a.id} onClick={() => onAgent(a.id)}>
                    {a.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="vc-label">{name} replies</p>
          <div className="vc-segmented small" role="group" aria-label="Reply mode">
            {options.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={mode === value} onClick={() => onMode(value)}>
                {label}
              </button>
            ))}
          </div>
          <p className="hint">{options.find(([value]) => value === mode)?.[2]}</p>
          <Button size="sm" variant="secondary" onClick={onAsk}>
            Ask agent now
          </Button>
        </>
      ) : (
        <p className="hint">Add an agent in Settings to work with an agent.</p>
      )}
    </div>
  );
}

function BarButton(props: {
  label: string;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="vc-bar-button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function FilterPanel({
  filter,
  onChange,
  place,
  marginFits,
  onPlace,
}: {
  marginFits: boolean;
  filter: ThreadFilter;
  onChange(f: ThreadFilter): void;
  place: CommentPlace;
  onPlace(place: CommentPlace): void;
}) {
  const seg = <K extends keyof ThreadFilter>(key: K, options: Array<[ThreadFilter[K], string]>) => (
    <div className="vc-segmented small" role="group">
      {options.map(([value, label]) => (
        <button
          key={String(value)}
          type="button"
          aria-pressed={filter[key] === value}
          onClick={() => onChange({ ...filter, [key]: value })}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div className="vc-filter" role="dialog" aria-label="Thread options">
      <>
        <p className="vc-label">Show threads</p>
        <div className="vc-segmented small" role="group" aria-label="Show threads">
          {(
            [
              ["below", "Under each block"],
              ["beside", "Beside the text"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={place === value} onClick={() => onPlace(value)}>
              {label}
            </button>
          ))}
        </div>
        {place === "beside" && !marginFits && (
          <p className="hint">The margin needs a wider window. Until then, threads show under each block.</p>
        )}
        <p className="vc-label">Which threads</p>
      </>
      {seg("status", [
        ["open", "Open"],
        ["all", "All"],
      ])}
      {seg("who", [
        ["everyone", "Everyone"],
        ["mine", "Mine"],
        ["agent", "Agent"],
      ])}
      {seg("suggestion", [
        [false, "Any"],
        [true, "Has a suggestion"],
      ])}
    </div>
  );
}

/** The session's one floating bar, Handscroll-style. Later tasks add Ask agent, Update, History, Snapshot. */
export function ActionBar({
  canComment,
  threadCount,
  unreadCount,
  onNextUnread,
  threadsShown,
  filter,
  onComment,
  onToggleThreads,
  onFilter,
  replyMode,
  modelReady,
  onReplyMode,
  agents,
  agent,
  onAgent,
  onAsk,
  onHistory,
  onSnapshot,
  place,
  marginFits,
  onPlace,
}: {
  /** Where threads show, as chosen; the margin is used only while it fits (`marginFits`). */
  place: CommentPlace;
  marginFits: boolean;
  onPlace(place: CommentPlace): void;
  onHistory(): void;
  onSnapshot(): void;
  replyMode: ReplyMode;
  modelReady: boolean;
  onReplyMode(mode: ReplyMode): void;
  onAsk(): void;
  /** Who can reply in this session, who does now, and the way to choose (W12). */
  agents: Array<{ id: SessionAgent; name: string }>;
  agent: SessionAgent | undefined;
  onAgent(agent: SessionAgent): void;
  canComment: boolean;
  threadCount: number;
  /** Threads with agent replies not looked at yet. */
  unreadCount: number;
  onNextUnread(): void;
  threadsShown: boolean;
  filter: ThreadFilter;
  onComment(): void;
  onToggleThreads(): void;
  onFilter(filter: ThreadFilter): void;
}) {
  const [panel, setPanel] = useState<"filter" | "agent">(),
    filtering = panel === "filter",
    setFiltering = (on: boolean | ((v: boolean) => boolean)) =>
      setPanel((current) => ((typeof on === "function" ? on(current === "filter") : on) ? "filter" : undefined)),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panel) return;
    const away = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setPanel(undefined);
    const key = (event: KeyboardEvent) => event.key === "Escape" && setPanel(undefined);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [panel]);
  const filtered = JSON.stringify(filter) !== JSON.stringify(defaultFilter);
  return (
    <div className="vc-bar-dock">
      <div className="vc-bar" ref={root} role="toolbar" aria-label="Session tools">
        {canComment && (
          <BarButton label="Comment on the whole session" onClick={onComment}>
            <Glyph d={bubble} />
          </BarButton>
        )}
        {canComment && (
          <BarButton
            label="Agent"
            pressed={panel === "agent"}
            onClick={() => setPanel((current) => (current === "agent" ? undefined : "agent"))}
          >
            <Glyph d={spark} />
          </BarButton>
        )}
        {canComment && modelReady && replyMode === "manual" && (
          <button type="button" className="vc-bar-button labelled" onClick={onAsk}>
            Ask agent
          </button>
        )}
        <BarButton
          label={`${threadsShown ? "Hide" : "Show"} ${threadCount > 0 ? plural(threadCount, "thread") : "threads"}`}
          pressed={threadsShown}
          onClick={onToggleThreads}
        >
          <Glyph d={margin} />
          {threadCount > 0 && <span className="count">{threadCount}</span>}
        </BarButton>
        {unreadCount > 0 && (
          <button type="button" className="vc-bar-button labelled vc-unread-jump" onClick={onNextUnread}>
            {unreadCount === 1 ? "1 new reply" : `${unreadCount} new replies`} ↓
          </button>
        )}
        <span className="vc-bar-sep" aria-hidden="true" />
        <BarButton label="History" onClick={onHistory}>
          <Icon name="clock" size={20} />
        </BarButton>
        {canComment && (
          <BarButton label={`Save a snapshot`} onClick={onSnapshot}>
            <Glyph d={bookmark} />
          </BarButton>
        )}
        <span className="vc-bar-sep" aria-hidden="true" />
        <BarButton label="Thread options" pressed={filtering || filtered} onClick={() => setFiltering((v) => !v)}>
          <Icon name="funnel" size={20} />
          {filtered && <span className="dot" aria-hidden="true" />}
        </BarButton>
        {filtering && (
          <FilterPanel filter={filter} onChange={onFilter} place={place} marginFits={marginFits} onPlace={onPlace} />
        )}
        {panel === "agent" && (
          <AgentPanel
            agents={agents}
            agent={agent}
            onAgent={onAgent}
            mode={replyMode}
            modelReady={modelReady}
            onMode={onReplyMode}
            onAsk={() => {
              setPanel(undefined);
              onAsk();
            }}
          />
        )}
      </div>
    </div>
  );
}
