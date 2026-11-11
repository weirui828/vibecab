import { useRef } from "react";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { Menu } from "../ui/Menu.js";
import type { MenuItem } from "../ui/Menu.js";
import { gondola, gondolaTransform } from "../ui/Gondola.js";
import { along, rideTable, swing } from "../ui/lineMotion.js";
import type { Pendulum } from "../ui/lineMotion.js";
import { useFrame } from "../ui/useFrame.js";
import { useWind } from "../shell/wind.js";
import { sessionStateItems } from "../session/SessionState.js";
import { attentionSentence, needsAction } from "./attentionText.js";
import { useActions } from "./actions.js";
import { useDialogs } from "./DialogHost.js";

const WIDTH = 420,
  SCALE = 0.058, // the little cab against the mark
  SAG = 10,
  /** At most this many versions are drawn; older ones are off the left end of the line. */
  STOPS = 5,
  ride = rideTable(5.4, 1.5, 1.9);

/** What one session's line shows: its versions as stops, the cab at the latest, and what hangs beside it. */
export interface LineShape {
  /** The first version drawn and the latest one. No Draft yet: both 0. */
  first: number;
  head: number;
  /** A stop for the version to come, drawn faint: only a session that can still change has one. */
  next: boolean;
  moving: boolean;
  open: number;
  agreed: number;
}

export function lineShape(session: SessionRow, head: number, items: AttentionItem[]): LineShape {
  const count = (kinds: AttentionItem["kind"][]) => items.filter((item) => kinds.includes(item.kind)).length;
  return {
    first: head === 0 ? 0 : Math.max(1, head - (STOPS - 2)),
    head,
    next: session.state === "active" && head > 0,
    moving: count(["running_update"]) > 0,
    open: count(["conflict", "failed_update", "proposal", "unread_reply"]),
    agreed: count(["agreed_item"]),
  };
}

/** Why the session stands where it does, in words. */
export function lineReason(session: SessionRow, items: AttentionItem[]): string {
  if (items.length) return attentionSentence(items);
  if (session.state === "paused") return `${terms.paused}. Nothing changes until you resume it.`;
  if (session.state === "ended") return `${terms.ended}. A read-only record.`;
  return "Nothing is waiting.";
}

function MiniLine({ shape }: { shape: LineShape }) {
  const { wind } = useWind(),
    car = useRef<SVGGElement>(null),
    rods = useRef<Array<SVGLineElement | null>>([]),
    grips = useRef<Array<SVGCircleElement | null>>([]),
    beads = useRef<Array<SVGCircleElement | null>>([]),
    hang = useRef<Pendulum & { t: number; speed: number; since: number }>({ theta: 0, omega: 0, t: 0, speed: 0, since: 0 });
  const stops = shape.head === 0 ? 1 : shape.head - shape.first + 1 + (shape.next ? 1 : 0),
    gap = stops > 1 ? Math.min(96, (WIDTH - 40) / (stops - 1)) : 0,
    stopX = (i: number) => 20 + i * gap,
    stopY = (i: number) => 24 - i * 2.2,
    at = shape.head === 0 ? 0 : shape.head - shape.first;
  // The little cable between two stops is one sagging curve; this is the point on it at t.
  const point = (i: number, t: number): [number, number] => {
    const ax = stopX(i),
      ay = stopY(i),
      bx = stopX(i + 1),
      by = stopY(i + 1),
      cy = (ay + by) / 2 + SAG;
    return [ax + (bx - ax) * t, (1 - t) ** 2 * ay + 2 * t * (1 - t) * cy + t * t * by];
  };
  const cableY = (x: number) => {
    if (stops < 2) return stopY(0);
    const i = Math.min(Math.max(Math.floor((x - 20) / gap), 0), stops - 2);
    return point(i, Math.min(Math.max((x - stopX(i)) / gap, 0), 1))[1];
  };
  useFrame((dt, clock) => {
    const h = hang.current;
    let push = 0;
    if (shape.moving && shape.next) {
      // An Update is running: the cab eases out of its stop and holds part of the way, until the new version lands.
      h.since += dt;
      const t = 0.62 * along(ride, h.since / 5.4),
        speed = (t - h.t) / dt;
      push = ((speed - h.speed) / dt) * 1.4;
      if (Math.abs(push) > 40) push = 0; // the first frame has no speed to compare with
      h.speed = speed;
      h.t = t;
    } else {
      h.t = 0;
      h.since = 0;
      h.speed = 0;
    }
    swing(h, dt, push + wind.level * 0.2 * Math.sin(clock * 1.3));
    const [x, y] = h.t > 0 ? point(at, h.t) : [stopX(at), stopY(at)];
    car.current?.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${(h.theta * 57.3).toFixed(2)})`);
    const cos = Math.cos(h.theta),
      sin = Math.sin(h.theta);
    gondola.rods.forEach(([rx, ry], k) => {
      const ax = rx * SCALE,
        ay = ry * SCALE,
        hx = x + ax,
        hy = cableY(hx), // each grip lands on the line itself
        rod = rods.current[k],
        grip = grips.current[k];
      grip?.setAttribute("cx", hx.toFixed(2));
      grip?.setAttribute("cy", (hy - 1).toFixed(2));
      rod?.setAttribute("x1", hx.toFixed(2));
      rod?.setAttribute("y1", hy.toFixed(2));
      rod?.setAttribute("x2", (x + ax * cos - ay * sin).toFixed(2));
      rod?.setAttribute("y2", (y + ax * sin + ay * cos + 0.5).toFixed(2));
    });
    beads.current.forEach((bead, k) => {
      bead?.setAttribute("cx", (x + 30 + k * 11).toFixed(2));
      bead?.setAttribute("cy", (y + 26).toFixed(2));
    });
  });
  const spans = Array.from({ length: Math.max(stops - 1, 0) }, (_, i) => i),
    hanging = [...Array<string>(shape.open).fill(""), ...Array<string>(shape.agreed).fill(" agreed")].slice(0, 6);
  return (
    <svg
      className="vc-mini"
      viewBox={`0 0 ${WIDTH} 70`}
      preserveAspectRatio="xMinYMid meet"
      aria-hidden="true"
      onPointerEnter={() => (hang.current.omega += 0.9)}
    >
      {spans.map((i) => (
        <path
          key={i}
          className={"vc-mini-cable" + (shape.next && i === stops - 2 && !shape.moving ? " ahead" : "")}
          d={`M${stopX(i)} ${stopY(i)}Q${(stopX(i) + stopX(i + 1)) / 2} ${(stopY(i) + stopY(i + 1)) / 2 + SAG} ${stopX(i + 1)} ${stopY(i + 1)}`}
        />
      ))}
      {Array.from({ length: stops }, (_, i) => {
        const ahead = shape.next && i === stops - 1;
        return (
          <g key={i} className={ahead ? "ahead" : undefined}>
            <circle className="vc-mini-stop" cx={stopX(i)} cy={stopY(i)} r="3" />
            {shape.head > 0 && (
              <text className="vc-mini-label" x={stopX(i)} y={stopY(i) - 8}>
                v{shape.first + i}
              </text>
            )}
          </g>
        );
      })}
      {[0, 1].map((k) => (
        <line key={k} className="vc-rod" strokeWidth="1.2" ref={(node) => void (rods.current[k] = node)} />
      ))}
      {[0, 1].map((k) => (
        <circle key={k} className="vc-grip" r="1.9" ref={(node) => void (grips.current[k] = node)} />
      ))}
      <g ref={car}>
        <use href="#vc-gondola" transform={gondolaTransform(SCALE)} />
      </g>
      {hanging.map((kind, k) => (
        <circle key={k} className={"vc-mini-bead" + kind} r="3.4" ref={(node) => void (beads.current[k] = node)} />
      ))}
    </svg>
  );
}

/** One session, one line: where the work stands, why, and the way in. */
export function SessionLines({
  sessions,
  drafts,
  attention,
}: {
  sessions: SessionRow[];
  drafts: DraftRow[];
  attention: Map<string, AttentionItem[]>;
}) {
  const actions = useActions(),
    dialogs = useDialogs(),
    byId = new Map(drafts.map((d) => [d.artifactId, d]));
  return (
    <ul className="vc-lines">
      {sessions.map((session, index) => {
        const items = attention.get(session.sessionId) ?? [],
          own = session.artifactIds.map((id) => byId.get(id)).filter((d): d is DraftRow => d !== undefined),
          head = own[0]?.headVersion ?? 0,
          names = own.map((d) => d.title);
        const menu: MenuItem[] = [
          { label: "Rename", onSelect: () => dialogs.rename("session", session.sessionId, session.title) },
          ...sessionStateItems(
            session,
            session.artifactIds.map((artifactId) => ({ artifactId })),
            actions,
            dialogs,
          ),
          {
            label: "Move to Trash",
            tone: "danger",
            separatorBefore: true,
            onSelect: () => void actions.trash("session", session.sessionId, session.title),
          },
        ];
        return (
          <li
            key={session.sessionId}
            className="vc-line"
            data-state={session.state}
            data-waiting={needsAction(items) || undefined}
            style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
          >
            <span className="main">
              <a className="title" href={"#/s/" + session.sessionId}>
                {session.title}
              </a>
              <span className="why">{lineReason(session, items)}</span>
            </span>
            <MiniLine shape={lineShape(session, head, items)} />
            <span className="end">
              <span className="cargo">
                {names.length === 0
                  ? `No ${terms.draft.toLowerCase()} yet`
                  : names.length === 1 && names[0] === session.title
                    ? `1 ${terms.draft}`
                    : names.join(" · ")}
              </span>
              {items.length > 0 && (
                <span className="vc-pill" title={attentionSentence(items)}>
                  {items.length}
                  <span className="sr-only"> waiting for you</span>
                </span>
              )}
              <Menu label={`Actions for ${session.title}`} items={menu} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
