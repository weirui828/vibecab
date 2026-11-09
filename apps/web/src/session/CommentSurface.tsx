import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@wei/design-system";
import type { Element, VcDeliveryStateOperation } from "../../../../contract/generated/index.js";
import { locatorForTextSelection } from "../../../ui/src/document/anchors.js";
import { AfterBlock } from "../document/DocumentView.js";
import { useLiveQuery } from "../live/LiveStore.js";
import { useCommentPlace } from "../shell/prefs.js";
import { ActionBar } from "./ActionBar.js";
import { ChangeHistory, changedBlocks, historyEntries } from "./ChangeHistory.js";
import type { ReplyMode } from "./ActionBar.js";
import { canDecide, threadStatus } from "./loop.js";
import type { Loop } from "./loop.js";
import { Composer } from "./Composer.js";
import { ThreadCard } from "./ThreadCard.js";
import { layoutMargin } from "./marginLayout.js";
import { byElementId, nextFrame, rectOf, selectionInElement } from "./textRanges.js";
import type { TextSelection } from "./textRanges.js";
import {
  anchorOf,
  applyFilter,
  defaultFilter,
  latestHuman,
  resolutionOf,
  sortByPosition,
  threadsForDraft,
  slotFinder,
  threadsBySlot,
  unreadReplies,
} from "./threads.js";
import type { Thread, ThreadFilter, TurnStatus } from "./threads.js";
import { useCommentActions } from "./useCommentActions.js";
import type { NewAnchor } from "./useCommentActions.js";
import { useHighlights } from "./useHighlights.js";
import { useBlockOutline } from "./useBlockOutline.js";

const WIDE = 900; // surface width at which a 280px margin fits beside a Document of at least ~58ch
const DRAFT = "__draft__";
const GENERAL = "__general__"; // threads shown in place but tied to no block: the whole session, or removed text

interface Writing {
  anchor?: NewAnchor;
  quote?: string;
}

const blockSelector = ".vc-doc > [data-element-id], .vc-doc li[data-element-id]";

export function CommentSurface({
  sessionId,
  artifactId,
  version,
  elements,
  readOnly,
  loop,
  replyMode,
  onOpenChanges,
  onHistory,
  onSnapshot,
  children,
}: {
  onHistory(): void;
  onSnapshot(): void;
  loop: Loop;
  replyMode: ReplyMode;
  onOpenChanges(version: number): void;
  sessionId: string;
  artifactId: string;
  version: number;
  elements: Element[];
  readOnly: boolean;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null),
    doc = useRef<HTMLDivElement>(null),
    cards = useRef(new Map<string, HTMLElement>()),
    actions = useCommentActions(sessionId);
  const [wide, setWide] = useState(true),
    [shown, setShown] = useState(true),
    [place, setPlace] = useCommentPlace(),
    [filter, setFilter] = useState<ThreadFilter>(defaultFilter),
    [focused, setFocused] = useState<string>(),
    [writing, setWriting] = useState<Writing>(),
    [picked, setPicked] = useState<{ selection: TextSelection; x: number; y: number }>(),
    [gutter, setGutter] = useState<{ elementId: string; top: number; height: number }>(),
    [why, setWhy] = useState<string>(),
    clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const all = useLiveQuery<Thread[]>("vc.Threads", { sessionId });
  const threads = useMemo(() => threadsForDraft(all.data ?? [], artifactId), [all.data, artifactId]);
  const shownThreads = useMemo(
    () =>
      sortByPosition(
        // "Open" also hides threads the loop has finished with (applied, declined, set aside).
        applyFilter(threads, filter).filter(
          (t) =>
            filter.status === "all" || !["applied", "declined", "muted"].includes(threadStatus(t, loop)?.tone ?? ""),
        ),
        elements,
      ),
    [threads, filter, elements, loop],
  );
  // Threads with replies not looked at yet, in reading order: the bar's "new replies" button walks them.
  const unreadThreads = shownThreads.filter((t) => unreadReplies(t).length > 0);
  const humanIds = shownThreads.map((t) => latestHuman(t)?.commentId).filter((id): id is string => Boolean(id));
  const delivery = useLiveQuery<VcDeliveryStateOperation["result"]>(
    "vc.DeliveryState",
    { commentIds: humanIds },
    humanIds.length > 0,
  );
  const turns = useLiveQuery<Array<{ turnId: string; status: TurnStatus }>>("vc.AgentTurns", { sessionId });
  const deliveryOf = (thread: Thread) => delivery.data?.find((d) => d.commentId === latestHuman(thread)?.commentId);
  const turnOf = (turnId: string | undefined) => turns.data?.find((t) => t.turnId === turnId)?.status;
  const ranges = useHighlights(doc, shownThreads, elements, focused, writing?.anchor);
  // Under each block (covibe's way) on narrow screens always, and on wide ones unless the margin is chosen.
  const inline = !wide || place === "below",
    margin = !inline && shown;

  // Wide enough for a margin? Measured on the surface itself, so the sidebar and window both count.
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    // Measure before the first paint, or a narrow window flashes the margin layout first.
    if (node.clientWidth > 0) setWide(node.clientWidth >= WIDE);
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= WIDE));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const startWriting = useCallback(
    (next: Writing) => {
      if (readOnly) return;
      setPicked(undefined);
      setWriting(next);
      if (!inline) setShown(true);
    },
    [readOnly, inline],
  );

  const writeOnSelection = useCallback(
    (selection: TextSelection) => {
      const element = elements.find((e) => e.elementId === selection.elementId);
      if (!element || !("text" in element)) return;
      const locator = locatorForTextSelection(element.text, selection.start, selection.end);
      startWriting({
        anchor: { artifactId, elementId: element.elementId, seenVersion: version, locator },
        quote: locator.quote,
      });
      window.getSelection()?.removeAllRanges();
    },
    [artifactId, elements, startWriting, version],
  );

  // Selecting words shows a small Comment button above the selection.
  useEffect(() => {
    if (readOnly) return;
    const update = () => {
      const selection = window.getSelection(),
        root = doc.current,
        host = surface.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !root || !host) return setPicked(undefined);
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return setPicked(undefined);
      const inElement = selectionInElement(range);
      if (!inElement) return setPicked(undefined);
      const rect = rectOf(range),
        base = host.getBoundingClientRect();
      setPicked({ selection: inElement, x: rect.left + rect.width / 2 - base.left, y: rect.top - base.top });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [readOnly]);

  // ⌘⌥M comments on the selection, or on the whole block around the caret.
  useEffect(() => {
    if (readOnly) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.code !== "KeyM") return;
      event.preventDefault();
      if (picked) return writeOnSelection(picked.selection);
      const node = window.getSelection()?.anchorNode,
        block = (node instanceof globalThis.Element ? node : node?.parentElement)?.closest<HTMLElement>(blockSelector);
      if (block?.dataset.elementId && doc.current?.contains(block))
        startWriting({ anchor: { artifactId, elementId: block.dataset.elementId, seenVersion: version } });
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [readOnly, picked, writeOnSelection, startWriting, artifactId, version]);

  useBlockOutline(doc, readOnly ? undefined : gutter?.elementId, writing?.anchor?.elementId, elements);

  // Where each card wants to sit: the top of its quote, else of its element.
  const anchorTop = useCallback(
    (thread: Thread): number | undefined => {
      const anchor = anchorOf(thread),
        host = surface.current;
      if (!anchor || !host || resolutionOf(thread)?.state === "removed") return undefined;
      const base = host.getBoundingClientRect().top,
        range = ranges.current.get(thread.threadId);
      if (range) return rectOf(range).top - base;
      const box = host.querySelector(byElementId(anchor.elementId));
      return box ? box.getBoundingClientRect().top - base : undefined;
    },
    [ranges],
  );

  // Place the margin cards beside their text, without overlaps; done on the DOM to avoid render loops.
  useLayoutEffect(() => {
    if (!margin) return;
    const place = () => {
      const host = surface.current;
      if (!host) return;
      const items = shownThreads.map((t) => ({
        id: t.threadId,
        anchorTop: anchorTop(t),
        height: cards.current.get(t.threadId)?.offsetHeight ?? 0,
      }));
      if (writing) {
        const box = writing.anchor ? host.querySelector(byElementId(writing.anchor.elementId)) : undefined;
        items.push({
          id: DRAFT,
          anchorTop: box ? box.getBoundingClientRect().top - host.getBoundingClientRect().top : undefined,
          height: cards.current.get(DRAFT)?.offsetHeight ?? 0,
        });
      }
      const tops = layoutMargin(items, writing ? DRAFT : focused);
      let bottom = 0;
      for (const item of items) {
        const card = cards.current.get(item.id),
          top = tops.get(item.id) ?? 0;
        if (card) {
          card.style.transform = `translateY(${Math.round(top)}px)`;
          if (!card.dataset.placed) nextFrame(() => (card.dataset.placed = "true"));
        }
        bottom = Math.max(bottom, top + item.height);
      }
      host.style.setProperty("--vc-margin-height", `${Math.ceil(bottom)}px`);
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    for (const card of cards.current.values()) observer?.observe(card);
    if (doc.current) observer?.observe(doc.current);
    return () => observer?.disconnect();
  }, [margin, shownThreads, writing, focused, anchorTop, elements]);

  const focusThread = useCallback((threadId: string, scrollCard: boolean) => {
    setFocused(threadId);
    if (scrollCard)
      nextFrame(() => cards.current.get(threadId)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
  }, []);
  const showText = (thread: Thread) => {
    setFocused(thread.threadId);
    const anchor = anchorOf(thread);
    if (!anchor) return;
    const range = ranges.current.get(thread.threadId),
      box = doc.current?.querySelector(byElementId(anchor.elementId));
    const target = range?.startContainer.parentElement ?? box;
    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };

  // A click on highlighted text focuses its thread; a click elsewhere on a block opens a comment on it (as in covibe).
  const onDocClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(".vc-inline") || window.getSelection()?.isCollapsed === false) return;
    const doc_ = event.currentTarget.ownerDocument as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const caret = doc_.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret)
      for (const [threadId, range] of ranges.current)
        if (range.isPointInRange(caret.startContainer, caret.startOffset)) return focusThread(threadId, true);
    // In the margin, a click on a commented block finds its card; in place, the threads are already right below.
    const marked = inline ? null : target.closest<HTMLElement>("[data-mark]");
    const id = marked?.dataset.elementId,
      thread = id ? shownThreads.find((t) => anchorOf(t)?.elementId === id) : undefined;
    if (thread) return focusThread(thread.threadId, true);
    if (readOnly || writing || event.detail > 1 || target.closest("a, button, input, textarea, summary")) return;
    const block = target.closest<HTMLElement>(blockSelector)?.dataset.elementId;
    if (!block) return;
    // Wait out a double click, which selects a word to comment on instead.
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      if (window.getSelection()?.isCollapsed === false) return;
      startWriting({ anchor: { artifactId, elementId: block, seenVersion: version } });
    }, 250);
  };
  useEffect(() => () => clearTimeout(clickTimer.current), []);

  // ↑/↓ move between cards.
  const onMarginKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const list = shownThreads.map((t) => cards.current.get(t.threadId)).filter((n): n is HTMLElement => Boolean(n));
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const next = list[at + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
    const id = next?.dataset.threadId;
    if (id) setFocused(id);
  };

  const submit = async ({ body, replacement }: { body: string; replacement?: string }) => {
    const mine = writing;
    const ok = await actions.comment(body, mine?.anchor, replacement);
    // Close only this composer: another one may have been opened while this comment was sending.
    if (ok) setWriting((current) => (current === mine ? undefined : current));
    return ok;
  };
  const composer = writing && (
    <Composer
      label={
        writing.anchor
          ? writing.quote
            ? "Comment on the selected words"
            : "Comment on this block"
          : "Comment on the whole session"
      }
      quote={writing.quote}
      allowSuggestion={writing.quote !== undefined}
      marks={writing.anchor !== undefined}
      onCancel={() => setWriting(undefined)}
      onSubmit={submit}
    />
  );
  const cardRef = (id: string) => (node: HTMLElement | null) => {
    if (node) cards.current.set(id, node);
    else cards.current.delete(id);
  };
  const card = (thread: Thread, positioned: boolean) => (
    <ThreadCard
      key={thread.threadId}
      ref={cardRef(thread.threadId)}
      thread={thread}
      focused={thread.threadId === focused}
      delivery={deliveryOf(thread)?.state}
      turn={turnOf(deliveryOf(thread)?.turnId)}
      readOnly={readOnly}
      actions={actions}
      decision={{
        status: threadStatus(thread, loop),
        canDecide: canDecide(thread, loop),
        manual: replyMode === "manual",
        modelReady: loop.modelReady,
        onOpenChanges,
      }}
      {...(positioned ? { style: { position: "absolute", top: 0, left: 0, right: 0 } } : {})}
      onActivate={() => {
        showText(thread);
        void actions.markRead(unreadReplies(thread).map((c) => c.commentId));
      }}
    />
  );

  // In place: each thread goes under its block (a list item, or the top-level block holding a table cell).
  const slotOf = useMemo(() => slotFinder(elements), [elements]);
  const changed = useMemo(() => changedBlocks(loop.updates, slotOf), [loop.updates, slotOf]);
  const bySlot = useMemo(() => threadsBySlot(shownThreads, slotOf, GENERAL), [shownThreads, slotOf]);
  const writingSlot = writing && ((writing.anchor && slotOf(writing.anchor.elementId)) ?? GENERAL);
  const newCard = (positioned: boolean) =>
    writing && (
      <div
        className="vc-thread vc-thread-new"
        ref={cardRef(DRAFT)}
        {...(positioned ? { style: { position: "absolute", top: 0, left: 0, right: 0 } } : {})}
      >
        {writing.quote && <blockquote className="quote">{writing.quote}</blockquote>}
        {composer}
      </div>
    );
  const inPlace = (slot: string) => {
    const list = shown ? (bySlot.get(slot) ?? []) : [],
      composing = writingSlot === slot;
    if (!list.length && !composing) return null;
    return (
      <div className="vc-inline" data-inline-for={slot === GENERAL ? undefined : slot}>
        {list.map((thread) => card(thread, false))}
        {composing && newCard(false)}
      </div>
    );
  };
  // A new comment opened from afar (the bar, a whole-session comment) scrolls into view.
  useEffect(() => {
    if (inline && writing)
      nextFrame(() => cards.current.get(DRAFT)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
  }, [inline, writing]);

  return (
    <div className="vc-surface" ref={surface} data-margin={margin || undefined}>
      <div
        className="vc-surface-doc"
        ref={doc}
        onClick={onDocClick}
        onMouseMove={(event) => {
          const block = (event.target as HTMLElement).closest<HTMLElement>(blockSelector),
            host = surface.current;
          if (!block?.dataset.elementId || !host) return;
          const box = block.getBoundingClientRect(),
            top = box.top - host.getBoundingClientRect().top;
          if (gutter?.elementId !== block.dataset.elementId)
            setGutter({ elementId: block.dataset.elementId, top, height: box.height });
        }}
        onMouseLeave={() => setGutter(undefined)}
        onDoubleClick={() => clearTimeout(clickTimer.current)}
        onKeyDown={inline ? onMarginKey : undefined}
      >
        {inline && inPlace(GENERAL)}
        <AfterBlock.Provider value={inline ? inPlace : undefined}>{children}</AfterBlock.Provider>
        {gutter && (
          <>
            {/* Bridges the gap between the block and its buttons, so the pointer never leaves on its way there. */}
            <div
              className="vc-gutter-rail"
              aria-hidden="true"
              style={{ top: gutter.top, height: Math.max(gutter.height, readOnly ? 32 : 66) }}
            />
            {!readOnly && (
              <button
                type="button"
                className="vc-gutter"
                style={{ top: gutter.top }}
                aria-label="Comment on this block"
                title="Comment on this block"
                onClick={() =>
                  startWriting({ anchor: { artifactId, elementId: gutter.elementId, seenVersion: version } })
                }
              >
                <Icon name="plus" size={16} />
              </button>
            )}
            {/* Only blocks an Update has changed have a history to show. */}
            {changed.has(gutter.elementId) && (
              <button
                type="button"
                className="vc-gutter why"
                style={{ top: gutter.top + (readOnly ? 0 : 34) }}
                aria-label="Change history"
                title="Change history"
                onClick={() => setWhy(gutter.elementId)}
              >
                <Icon name="clock" size={16} />
              </button>
            )}
          </>
        )}
      </div>
      {picked && !writing && (
        <button
          type="button"
          className="vc-pick"
          style={{ left: picked.x, top: picked.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => writeOnSelection(picked.selection)}
        >
          Comment
          <span className="vc-facts">⌘⌥M</span>
        </button>
      )}
      {margin && (
        <aside className="vc-margin" aria-label="Threads" onKeyDown={onMarginKey}>
          {shownThreads.map((thread) => card(thread, true))}
          {newCard(true)}
        </aside>
      )}
      <ChangeHistory
        open={why !== undefined}
        entries={why ? historyEntries(why, loop.updates, loop.agreements, all.data ?? [], slotOf) : []}
        onClose={() => setWhy(undefined)}
      />
      <ActionBar
        canComment={!readOnly}
        threadCount={shownThreads.length}
        unreadCount={unreadThreads.length}
        onNextUnread={() => {
          const next = unreadThreads[0];
          if (!next) return;
          setShown(true);
          focusThread(next.threadId, true);
          void actions.markRead(unreadReplies(next).map((c) => c.commentId));
        }}
        layout={shown ? place : "hidden"}
        marginFits={wide}
        filter={filter}
        onComment={() => startWriting({})}
        // Hidden lasts for this visit; the place (under or beside) is remembered per browser.
        onLayout={(next) => (setShown(next !== "hidden"), next !== "hidden" && setPlace(next))}
        onFilter={setFilter}
        replyMode={replyMode}
        modelReady={loop.modelReady}
        onReplyMode={(mode) => void actions.setReplyMode(mode)}
        agents={loop.agents}
        agent={loop.agent}
        onAgent={(agent) => void actions.setAgent(agent)}
        onAsk={() => void actions.ask()}
        onHistory={onHistory}
        onSnapshot={onSnapshot}
      />
    </div>
  );
}
