import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@wei/design-system";
import type { ThreadFilter } from "./threads.js";
import { defaultFilter } from "./threads.js";

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

function FilterPanel({ filter, onChange }: { filter: ThreadFilter; onChange(f: ThreadFilter): void }) {
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
    <div className="vc-filter" role="dialog" aria-label="Filter threads">
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
  threadsShown,
  filter,
  onComment,
  onToggleThreads,
  onFilter,
}: {
  canComment: boolean;
  threadCount: number;
  threadsShown: boolean;
  filter: ThreadFilter;
  onComment(): void;
  onToggleThreads(): void;
  onFilter(filter: ThreadFilter): void;
}) {
  const [filtering, setFiltering] = useState(false),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filtering) return;
    const away = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setFiltering(false);
    const key = (event: KeyboardEvent) => event.key === "Escape" && setFiltering(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [filtering]);
  const filtered = JSON.stringify(filter) !== JSON.stringify(defaultFilter);
  return (
    <div className="vc-bar-dock">
      <div className="vc-bar" ref={root} role="toolbar" aria-label="Session tools">
        {canComment && (
          <BarButton label="Comment on the whole session" onClick={onComment}>
            <Glyph d={bubble} />
          </BarButton>
        )}
        <BarButton
          label={threadsShown ? "Hide threads" : "Show threads"}
          pressed={threadsShown}
          onClick={onToggleThreads}
        >
          <Glyph d={margin} />
          {threadCount > 0 && <span className="count">{threadCount}</span>}
        </BarButton>
        <BarButton label="Filter threads" pressed={filtering || filtered} onClick={() => setFiltering((v) => !v)}>
          <Icon name="funnel" size={20} />
          {filtered && <span className="dot" aria-hidden="true" />}
        </BarButton>
        {filtering && <FilterPanel filter={filter} onChange={onFilter} />}
      </div>
    </div>
  );
}
