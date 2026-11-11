import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { SessionRow } from "../live/workspace.js";
import { gondola, gondolaTransform } from "../ui/Gondola.js";
import { along, makeString, pluck, rideTable, stepString, swing, waveAt } from "../ui/lineMotion.js";
import type { Pendulum, StringLine } from "../ui/lineMotion.js";
import { prefersCalm, useFrame } from "../ui/useFrame.js";
import { useWind } from "../shell/wind.js";

// The cable is time. Each version of the Draft is a station; the cab hangs at the latest one. An Update sends it
// out along the line, and the new version is where it arrives. The cab is hung on the cable point for point: its
// place and the cable's shape come from one function.

const SPAN = 420, // between stations
  RISE = 23, // each station stands this much higher than the one before
  HOME_X = 590,
  HOME_Y = 128,
  STEP = 7, // between the cable's own points
  SCALE = 0.105, // the cab against the mark
  RIDE_SECONDS = 5.4,
  ride = rideTable(RIDE_SECONDS, 1.5, 1.9),
  /** Stations drawn, as steps from the one the cab is at: two behind, two ahead. */
  STEPS = [-2, -1, 0, 1, 2];

/** Lets the plumb line tell the cab that an agreed change has come aboard. */
export interface CabSignals {
  board(): void;
}
export const CabContext = createContext<{ current: CabSignals | undefined }>({ current: undefined });
export const useCab = () => useContext(CabContext);

type Mode = "rest" | "out" | "in" | "back";

interface Motion extends Pendulum {
  mode: Mode;
  t: number; // 0 at the station the cab left, 1 at the next
  from: number;
  time: number;
  /** How far along the span the cab was a frame ago, and how fast it was going. */
  x: number;
  speed: number;
  /** After an arrival the whole line slides back by one station, so the cab ends where it always rests. */
  shift: number;
  spin: number;
  phase: number;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

export function statusWord(state: SessionRow["state"], running: boolean, agreed: number, open: number): string {
  if (state === "ended") return "ENDED";
  if (state === "paused") return "PAUSED";
  if (running) return "EN ROUTE";
  if (agreed > 0) return "READY";
  return open > 0 ? "WAITING" : "CLEAR";
}

function Flap({ text }: { text: string }) {
  return (
    <span className="vc-flap" aria-hidden="true">
      {[...text].map((letter, i) => (
        // A new letter is a new flap: it turns over as it arrives.
        <span key={i + letter}>{letter}</span>
      ))}
    </span>
  );
}

export function CableScene({
  session,
  head,
  running,
  open,
  agreed,
}: {
  session: SessionRow;
  /** The Draft's latest version; 0 while there is no Draft. */
  head: number;
  running: boolean;
  open: number;
  agreed: number;
}) {
  const { wind } = useWind(),
    signals = useCab(),
    [shown, setShown] = useState(head),
    cable = useRef<SVGPathElement>(null),
    tail = useRef<SVGPathElement>(null),
    stations = useRef<SVGGElement>(null),
    car = useRef<SVGGElement>(null),
    rods = useRef<Array<SVGLineElement | null>>([]),
    grips = useRef<Array<SVGCircleElement | null>>([]),
    waves = useRef<Array<SVGPathElement | null>>([]),
    strings = useRef<StringLine[]>(STEPS.slice(1).map(() => makeString(SPAN / STEP + 1))).current,
    m = useRef<Motion>({
      mode: "rest",
      t: 0,
      from: 0,
      time: 0,
      x: 0,
      speed: 0,
      shift: 0,
      spin: 0,
      phase: 0,
      theta: 0,
      omega: 0,
    }).current,
    load = useRef(agreed);
  load.current = agreed;

  // An Update starts: the cab leaves. It stops: the cab comes back, unless a new version is where it was going.
  useEffect(() => {
    if (running && m.mode === "rest") {
      m.mode = "out";
      m.time = 0;
      pluck(strings[2]!, 0.05, -4); // the haul rope takes up the slack
    } else if (!running && m.mode === "out") {
      m.mode = "back";
      m.from = m.t;
      m.time = 0;
    }
  }, [running, m, strings]);
  // A new version: the cab rides in to it, wherever it was.
  useEffect(() => {
    if (head === shown) return;
    if (head < shown || shown === 0 || prefersCalm() || typeof window.requestAnimationFrame !== "function") {
      setShown(head);
      m.mode = "rest";
      m.t = 0;
      return;
    }
    if (m.mode !== "in") {
      m.mode = "in";
      m.from = m.t;
      m.time = 0;
    }
  }, [head, shown, m]);
  useEffect(() => {
    signals.current = {
      board() {
        m.omega += 0.1; // the cab takes the weight
        pluck(strings[2]!, 0.06, 3);
      },
    };
    return () => void (signals.current = undefined);
  }, [signals, m, strings]);

  useFrame((dt, clock) => {
    for (const s of strings) stepString(s);
    // Where the cab is along its span.
    m.time += dt;
    if (m.mode === "out") {
      // Out of the station with an ease, then on at a crawl: the work takes as long as it takes.
      const eased = 0.55 * along(ride, m.time / RIDE_SECONDS);
      m.t = eased + (m.time > RIDE_SECONDS ? 0.25 * (1 - Math.exp(-(m.time - RIDE_SECONDS) / 40)) : 0);
    } else if (m.mode === "in") {
      const whole = m.from < 0.05 ? RIDE_SECONDS : 2.6,
        part = Math.min(1, m.time / whole);
      m.t = m.from + (1 - m.from) * (m.from < 0.05 ? along(ride, part) : smooth(part));
      if (part >= 1) {
        // Arrived. The line is renumbered around the cab, and slides back so the cab rests where it always does.
        m.mode = "rest";
        m.t = 0;
        m.shift = 1;
        m.time = 0;
        m.x = 0;
        m.speed = 0;
        pluck(strings[1]!, 0.94, 5);
        pluck(strings[2]!, 0.1, 4);
        setShown(head);
      }
    } else if (m.mode === "back") {
      const part = Math.min(1, m.time / 2.4);
      m.t = m.from * (1 - smooth(part));
      if (part >= 1) m.mode = "rest";
    } else if (m.shift > 0) {
      m.shift = 1 - smooth(Math.min(1, m.time / 1.6));
    }

    const post = (step: number) => ({ x: HOME_X + SPAN * (step + m.shift), y: HOME_Y - RISE * (step + m.shift) });
    // The cable's height anywhere on span k (from station k-2 to the next): the straight chord, its own sag, the
    // dent the cab presses into it, and the wave on it.
    const dent = (k: number, t: number) => {
      const c = m.t;
      if (k !== 2 || c <= 0.0005 || c >= 0.9995) return 0;
      return (15 + load.current * 3) * 4 * c * (1 - c) * (t < c ? t / c : (1 - t) / (1 - c));
    };
    const heightAt = (k: number, t: number) => {
      const a = post(k - 2),
        b = post(k - 1);
      return a.y + (b.y - a.y) * t + 19 * 4 * t * (1 - t) + dent(k, t) + waveAt(strings[k]!, t);
    };
    const heightAtX = (x: number) => {
      const k = Math.min(Math.max(Math.floor((x - post(-2).x) / SPAN), 0), 3);
      return heightAt(k, Math.min(Math.max((x - post(k - 2).x) / SPAN, 0), 1));
    };
    const draw = (k: number) => {
      const s = strings[k]!,
        a = post(k - 2);
      let d = "";
      for (let j = 0; j < s.n; j++) {
        const t = j / (s.n - 1);
        d += `${j ? "L" : "M"}${(a.x + SPAN * t).toFixed(1)} ${heightAt(k, t).toFixed(2)}`;
        // The cab's own point goes into the line, so the kink under it is exactly where the cab hangs.
        if (k === 2 && m.t * (s.n - 1) > j && m.t * (s.n - 1) < j + 1)
          d += `L${(a.x + SPAN * m.t).toFixed(1)} ${heightAt(k, m.t).toFixed(2)}`;
      }
      return d;
    };
    cable.current?.setAttribute("d", draw(0) + draw(1) + draw(2));
    tail.current?.setAttribute("d", draw(3));
    stations.current?.setAttribute(
      "transform",
      `translate(${(SPAN * m.shift).toFixed(2)} ${(-RISE * m.shift).toFixed(2)})`,
    );

    // The cab is a pendulum under its grips: it hangs back when the line pulls away and swings forward on braking.
    const gx = post(0).x + SPAN * m.t,
      gy = heightAt(2, m.t),
      // Speed along the line itself: the slide after an arrival moves the picture, not the cab.
      travelled = SPAN * m.t,
      speed = (travelled - m.x) / dt,
      push = Math.abs(speed - m.speed) / dt > 4000 ? 0 : (speed - m.speed) / dt / 140;
    m.spin += (travelled - m.x) / 5;
    m.speed = speed;
    m.x = travelled;
    swing(m, dt, push + 0.02 * Math.sin(clock * 0.9) + wind.level * 0.16 * Math.sin((wind.clock - wind.from) * 1.3));
    car.current?.setAttribute(
      "transform",
      `translate(${gx.toFixed(2)} ${gy.toFixed(2)}) rotate(${((m.theta * 180) / Math.PI).toFixed(2)})`,
    );
    const cos = Math.cos(m.theta),
      sin = Math.sin(m.theta);
    gondola.rods.forEach(([rx, ry], i) => {
      const ax = rx * SCALE,
        ay = ry * SCALE,
        hx = gx + ax,
        hy = heightAtX(hx), // each grip sits on the cable at its own x
        rod = rods.current[i],
        grip = grips.current[i];
      grip?.setAttribute("cx", hx.toFixed(2));
      grip?.setAttribute("cy", (hy - 1.6).toFixed(2));
      rod?.setAttribute("x1", hx.toFixed(2));
      rod?.setAttribute("y1", hy.toFixed(2));
      rod?.setAttribute("x2", (gx + ax * cos - ay * sin).toFixed(2));
      rod?.setAttribute("y2", (gy + ax * sin + ay * cos + 0.6).toFixed(2));
    });
    stations.current?.style.setProperty("--vc-spin", `${(m.spin * 57.3).toFixed(1)}deg`);

    // The tuner: you and the agent as two waves, sliding into step as threads are agreed. In tune, it rests.
    m.phase += (open * 1.1 - m.phase) * 0.06;
    const moving = open > 0 ? clock * 1.6 : 0;
    [
      [m.phase, 6 + Math.min(open, 3)],
      [0, 6],
    ].forEach(([offset, height], i) => {
      let d = "";
      for (let x = 1; x <= 65; x += 2)
        d += `${d ? "L" : "M"}${x} ${(10.5 + (height ?? 6) * Math.sin(x * 0.2 + moving + (offset ?? 0))).toFixed(1)}`;
      waves.current[i]?.setAttribute("d", d);
    });
  });

  const status = statusWord(session.state, running, agreed, open),
    where = shown > 0 ? `version ${shown}` : "no version yet";
  return (
    <div className="vc-scene vc-cable-scene">
      <svg viewBox="0 0 1200 380" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <g className="vc-stars">
          <circle cx="140" cy="50" r="1.6" />
          <circle cx="420" cy="28" r="1.3" style={{ animationDelay: "1s" }} />
          <circle cx="700" cy="60" r="1.6" style={{ animationDelay: "2s" }} />
          <circle cx="930" cy="34" r="1.2" style={{ animationDelay: "0.5s" }} />
          <circle cx="1110" cy="70" r="1.5" style={{ animationDelay: "1.6s" }} />
        </g>
        <path className="vc-aurora a1" d="M-40 90 C 200 20, 420 130, 660 60 S 1040 40, 1260 100" />
        <path className="vc-aurora a2" d="M-40 130 C 240 70, 460 160, 720 100 S 1060 90, 1260 140" />
        <circle className="vc-orb-glow" cx="860" cy="222" r="46" />
        <circle className="vc-orb" cx="860" cy="222" r="19" />
        <path className="vc-hill far" d="M0 300 Q 150 214 330 276 T 640 258 T 930 250 T 1200 286 V380 H0Z" />
        <path className="vc-hill mid" d="M0 334 Q 200 262 420 318 T 800 300 T 1200 322 V380 H0Z" />
        <path className="vc-hill near" d="M0 360 Q 260 314 520 356 T 1200 348 V380 H0Z" />
        <g ref={stations}>
          {STEPS.map((step) => {
            const version = shown + step,
              x = HOME_X + SPAN * step,
              y = HOME_Y - RISE * step,
              mast = x - 48;
            if (version < 1) return null;
            return (
              // The mast stands to one side and holds the cable out on an arm, so a cab at the station hangs clear.
              <g key={version} className={"vc-station" + (version > shown ? " ahead" : "")}>
                <path
                  className="vc-tower"
                  d={`M${mast} ${y - 4}V372M${mast - 20} 372L${mast} ${y + 120}L${mast + 20} 372`}
                />
                <path className="vc-tower" d={`M${mast} ${y + 5}H${x - 5}M${mast} ${y + 36}L${x - 16} ${y + 5}`} />
                <path className="vc-deck" d={`M${mast - 12} ${y + 96}H${x + 52}`} />
                <g style={{ transform: "rotate(var(--vc-spin, 0deg))", transformOrigin: `${x}px ${y + 5}px` }}>
                  <circle className="vc-sheave" cx={x} cy={y + 5} r="5" />
                  <path className="vc-tower thin" d={`M${x - 4} ${y + 5}H${x + 4}M${x} ${y + 1}V${y + 9}`} />
                </g>
                <g className="vc-sign">
                  <rect x={x - 19} y={y - 36} width="38" height="19" rx="4" />
                  <text x={x} y={y - 22.5}>
                    v{version}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
        <path ref={tail} className="vc-cable tail" />
        <path ref={cable} className="vc-cable" />
        {[0, 1].map((i) => (
          <line key={i} className="vc-rod" ref={(node) => void (rods.current[i] = node)} />
        ))}
        <g ref={car} className="vc-cab">
          <use href="#vc-gondola" transform={gondolaTransform(SCALE)} />
        </g>
        {[0, 1].map((i) => (
          <circle key={i} className="vc-grip" r="3.1" ref={(node) => void (grips.current[i] = node)} />
        ))}
      </svg>
      <div className="vc-board" role="status">
        <span className="sr-only">
          At {where}. {status.toLowerCase()}. {open > 0 ? `${open} open` : "Nothing open"}.
        </span>
        <span className="cell">
          <small aria-hidden="true">AT</small>
          <Flap text={shown > 0 ? "V" + shown : "--"} />
        </span>
        <span className="cell">
          <small aria-hidden="true">STATUS</small>
          <Flap text={status.padEnd(8)} />
        </span>
        <span className="cell" aria-hidden="true">
          <small>{open > 0 ? `${open} OPEN` : "IN TUNE"}</small>
          <svg className="vc-tuner" width="66" height="21" viewBox="0 0 66 21">
            <path className="agent" ref={(node) => void (waves.current[0] = node)} />
            <path className="you" ref={(node) => void (waves.current[1] = node)} />
          </svg>
        </span>
      </div>
    </div>
  );
}
