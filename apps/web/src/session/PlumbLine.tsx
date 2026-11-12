import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { isStill, makeString, pluck, stepString, waveAt } from "../ui/lineMotion.js";
import type { StringLine } from "../ui/lineMotion.js";
import { useFrame } from "../ui/useFrame.js";
import { lean, useWind } from "../shell/wind.js";
import { useCab } from "./CableScene.js";
import { byElementId } from "./textRanges.js";
import { anchorOf, threadState, visibleComments } from "./threads.js";
import type { Thread } from "./threads.js";

// The plumb line is place. It hangs beside the Document; a bead sits where each thread is: hollow while it is
// open, filled once agreed, small once written in. It answers the pointer: coming onto a block plucks it there.
// Left alone it shivers faintly now and then, and a rare gust leans it.

export interface Bead {
  threadId: string;
  elementId: string;
  state: "open" | "agreed" | "applied";
  /** The thread's first words, for whoever points at the bead. */
  said: string;
}

/** The threads that have a place in the Draft, as beads. Declined and set-aside ones leave the line. */
export function beadsOf(threads: Thread[]): Bead[] {
  return threads.flatMap((thread) => {
    const elementId = anchorOf(thread)?.elementId,
      state = threadState(thread);
    if (!elementId || state === "declined" || state === "superseded") return [];
    return [
      {
        threadId: thread.threadId,
        elementId,
        said: (visibleComments(thread)[0]?.body ?? "").replace(/\s+/g, " ").slice(0, 90),
        state: state === "applied" ? "applied" : state === "agreed" || state === "scheduled" ? "agreed" : "open",
      } as const,
    ];
  });
}

const X = 14, // the line's place across its own narrow box
  STEP = 6,
  label: Record<Bead["state"], string> = {
    open: "Open thread",
    agreed: "Agreed thread, waiting for the next Update",
    applied: "Thread written into the Draft",
  };

export function PlumbLine({
  host,
  threads,
  onOpen,
}: {
  /** The surface the Document is laid out in; blocks are found inside it by their element id. */
  host: RefObject<HTMLElement | null>;
  threads: Thread[];
  onOpen(threadId: string): void;
}) {
  const beads = useMemo(() => beadsOf(threads), [threads]),
    { wind } = useWind(),
    cab = useCab(),
    [layout, setLayout] = useState<{ height: number; at: Record<string, number> }>({ height: 0, at: {} }),
    line = useRef<StringLine>(makeString(8)),
    path = useRef<SVGPathElement>(null),
    bob = useRef<SVGPathElement>(null),
    riser = useRef<SVGCircleElement>(null),
    dots = useRef(new Map<string, SVGCircleElement>()),
    rising = useRef<{ from: number; part: number } | undefined>(undefined),
    before = useRef(new Map<string, Bead["state"]>()),
    lastPluck = useRef(-1),
    clockNow = useRef(0),
    shiver = useRef(4);
  const key = beads.map((b) => b.threadId + b.elementId).join(" ");

  // Where each bead sits: beside the first line of its block. Measured again whenever the surface changes size.
  useEffect(() => {
    const surface = host.current,
      doc = surface?.querySelector<HTMLElement>(".vc-surface-doc");
    if (!surface || !doc) return;
    const measure = () => {
      const top = surface.getBoundingClientRect().top,
        at: Record<string, number> = {},
        taken = new Map<string, number>();
      for (const bead of beads) {
        const block = surface.querySelector(byElementId(bead.elementId));
        if (!block) continue;
        const nth = taken.get(bead.elementId) ?? 0;
        taken.set(bead.elementId, nth + 1);
        at[bead.threadId] = block.getBoundingClientRect().top - top + 14 + nth * 15;
      }
      const height = Math.max(0, doc.getBoundingClientRect().height);
      setLayout((old) =>
        old.height === height && JSON.stringify(old.at) === JSON.stringify(at) ? old : { height, at },
      );
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(measure);
    watch.observe(doc);
    return () => watch.disconnect();
    // `key` stands for the beads that matter to the layout: which threads, on which blocks.
  }, [host, key]);

  useEffect(() => {
    const points = Math.round(layout.height / STEP) + 1;
    if (points !== line.current.n) line.current = makeString(points);
  }, [layout.height]);

  // A touch: the pointer coming onto a block plucks the line beside it, a little harder where a thread sits.
  // (An HTML Draft's blocks are inside its frame; the frame's view passes the move on to the block's box.)
  useEffect(() => {
    const surface = host.current;
    if (!surface) return;
    let on = "";
    const move = (event: Event) => {
      const block = (event.target as HTMLElement).closest?.<HTMLElement>("[data-element-id]"),
        id = block?.dataset.elementId ?? "";
      if (!block || !id) return void (on = "");
      if (id === on || layout.height === 0 || clockNow.current - lastPluck.current < 0.18) return;
      on = id;
      lastPluck.current = clockNow.current;
      const y = block.getBoundingClientRect().top - surface.getBoundingClientRect().top + 14,
        threaded = beads.some((b) => b.elementId === id && b.state !== "applied");
      pluck(line.current, Math.min(Math.max(y / layout.height, 0.02), 0.98), threaded ? 4.5 : 2.4);
    };
    surface.addEventListener("mousemove", move);
    return () => surface.removeEventListener("mousemove", move);
  }, [host, beads, layout]);

  // Agreeing: the bead rings once, and its change goes up the line to the cab.
  useEffect(() => {
    for (const bead of beads) {
      const was = before.current.get(bead.threadId),
        y = layout.at[bead.threadId];
      if (was === "open" && bead.state === "agreed" && y !== undefined && layout.height > 0) {
        pluck(line.current, y / layout.height, 8);
        rising.current = { from: y, part: 0 };
      }
      before.current.set(bead.threadId, bead.state);
    }
  }, [beads, layout]);

  useFrame(
    (dt, clock) => {
      clockNow.current = clock;
      const s = line.current,
        h = layout.height;
      if (h === 0) return;
      // Left alone, the line still stirs now and then: a faint shiver somewhere along it, never a swing.
      if (clock >= shiver.current) {
        shiver.current = clock + 7 + Math.random() * 11;
        pluck(s, 0.15 + Math.random() * 0.7, (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.9));
      }
      if (!isStill(s)) stepString(s);
      // Where the line is at height y: its own ringing plus the lean of the gust.
      const side = (y: number) => X + waveAt(s, y / h) + 5 * lean(wind, y / h);
      let d = "";
      for (let j = 0; j < s.n; j++) {
        const y = (j / (s.n - 1)) * h;
        d += `${j ? "L" : "M"}${side(y).toFixed(2)} ${y.toFixed(1)}`;
      }
      path.current?.setAttribute("d", d);
      bob.current?.setAttribute("transform", `translate(${X} ${h.toFixed(1)})`);
      for (const [threadId, dot] of dots.current) {
        const y = layout.at[threadId];
        if (y !== undefined) dot.setAttribute("cx", side(y).toFixed(2));
      }
      const up = rising.current;
      if (up) {
        up.part = Math.min(1, up.part + dt / 0.9);
        const eased = up.part * up.part * (3 - 2 * up.part),
          y = up.from * (1 - eased);
        riser.current?.setAttribute("cx", side(y).toFixed(2));
        riser.current?.setAttribute("cy", y.toFixed(1));
        riser.current?.setAttribute("opacity", String(Math.min(1, (1 - up.part) * 5)));
        if (up.part >= 1) {
          rising.current = undefined;
          cab.current?.board();
        }
      }
    },
    true,
    layout,
  );

  if (layout.height === 0) return null;
  return (
    <svg className="vc-plumb" height={layout.height + 22} aria-label="Threads along the Draft" role="group">
      <path ref={path} className="vc-cable" aria-hidden="true" />
      <path ref={bob} className="vc-plumb-bob" d="M0 0l5 9-5 9-5-9z" aria-hidden="true" />
      <circle ref={riser} className="vc-plumb-riser" r="4.5" opacity="0" aria-hidden="true" />
      {beads.map((bead) => {
        const y = layout.at[bead.threadId];
        if (y === undefined) return null;
        return (
          <circle
            key={bead.threadId}
            ref={(node) => void (node ? dots.current.set(bead.threadId, node) : dots.current.delete(bead.threadId))}
            className="vc-bead"
            data-state={bead.state}
            cx={X}
            cy={y}
            r="6"
            role="button"
            tabIndex={0}
            aria-label={bead.said ? `${label[bead.state]}: ${bead.said}` : label[bead.state]}
            onClick={(event) => {
              event.stopPropagation(); // a click on the Document itself starts a comment; this one opens a thread
              onOpen(bead.threadId);
            }}
            onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onOpen(bead.threadId)}
          >
            <title>{bead.said}</title>
          </circle>
        );
      })}
    </svg>
  );
}
