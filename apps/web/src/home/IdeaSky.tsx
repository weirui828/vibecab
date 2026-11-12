import { useEffect, useMemo, useRef, useState } from "react";
import type { Idea } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import { plural } from "../ui/time.js";
import { prefersCalm, useFrame } from "../ui/useFrame.js";
import { Sky, tipPlace } from "./skyLayout.js";
import type { Star } from "./skyLayout.js";

// Ideas as a night sky. Each idea is a star; ideas that are close are joined into constellations, named by the
// words they share. A new idea flashes in, crosses the sky and joins its kin, and the stars that were there shift
// slowly to make room. The list is the same ideas in words, and stays one switch away.

const PLACES = "vc-idea-sky",
  TINTS = 6;

/** Can this browser draw the sky at all? (Where it cannot, the list is shown.) */
export const canDrawSky = () => typeof window !== "undefined" && typeof window.CanvasRenderingContext2D === "function";

function readPlaces(): Record<string, [number, number]> {
  try {
    return JSON.parse(localStorage.getItem(PLACES) ?? "{}") as Record<string, [number, number]>;
  } catch {
    return {};
  }
}
function keepPlaces(places: Record<string, [number, number]>) {
  try {
    localStorage.setItem(PLACES, JSON.stringify(places));
  } catch {
    // Storage can be unavailable; the sky is then laid out again on the next visit.
  }
}

interface Flight {
  star: Star;
  from: [number, number];
  bend: number;
  since: number;
  trail: Array<[number, number]>;
}
interface Ring {
  x: number;
  y: number;
  at: number;
  tint: string;
  reach: number;
}

export function IdeaSky({
  ideas,
  where,
  onGather,
  onDraft,
}: {
  ideas: Idea[];
  /** Where an idea is used already, in words. */
  where(idea: Idea): string;
  onGather(ideas: Idea[]): void;
  onDraft(ideas: Idea[]): void;
}) {
  const sky = useRef(new Sky()).current,
    box = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    size = useRef({ w: 0, h: 0 }),
    colours = useRef({ star: "", tints: [] as string[], mono: "monospace" }),
    motion = useRef({
      now: 0,
      heat: 0,
      flights: [] as Flight[],
      rings: [] as Ring[],
      born: new Map<string, number>(), // when a line was first drawn
      landed: new Map<string, number>(), // when a new star arrived
      stirred: new Map<string, number>(), // when a constellation was joined
      ready: false,
    }).current,
    [chosen, setChosen] = useState<string>(),
    [hover, setHover] = useState<string>(),
    [said, setSaid] = useState<{ line: string; small: string }>(),
    calm = prefersCalm();
  const byId = useMemo(() => new Map(ideas.map((idea) => [idea.ideaId, idea])), [ideas]);
  const key = ideas.map((idea) => idea.ideaId + idea.text).join("\n");

  // Where a star is on the screen. One whose constellation was just joined trembles for a moment.
  const at = (star: Star): [number, number] => {
    const { w, h } = size.current,
      since = motion.stirred.get(star.id),
      stir = since === undefined || calm ? 0 : Math.max(0, 1 - (motion.now - since) / 1.6),
      phase = (motion.now - (since ?? 0)) * 16 + star.beat;
    return [
      w / 2 + star.x * (w / 2 - 24) + Math.sin(phase) * 3.2 * stir * stir,
      h / 2 - 16 + star.y * (h / 2 - 30) + Math.cos(phase * 1.3) * 3.2 * stir * stir,
    ];
  };
  const tintOf = (star: Star) =>
    star.home ? (colours.current.tints[star.home.tint % TINTS] ?? colours.current.star) : colours.current.star;

  // The sky holds exactly the ideas there are. The first time, it is laid out (or put back as it was last
  // visit); after that, an idea that appears flies in.
  useEffect(() => {
    const fresh = sky.set(
      ideas.map((idea) => ({ id: idea.ideaId, text: idea.text })),
      motion.ready ? {} : readPlaces(),
    );
    const lineKeys = new Set(sky.lines.map((l) => l.a.id + "|" + l.b.id));
    for (const k of [...motion.born.keys()]) if (!lineKeys.has(k)) motion.born.delete(k);
    if (!motion.ready) {
      motion.ready = true;
      for (const k of lineKeys) motion.born.set(k, -10);
      keepPlaces(sky.places());
      return;
    }
    for (const k of lineKeys) if (!motion.born.has(k)) motion.born.set(k, motion.now);
    for (const star of fresh) {
      const kin = sky.kin(star),
        first = kin[0];
      setSaid({
        line: first
          ? star.home && star.home.stars.length > 2 && star.home.name
            ? `It joins “${star.home.name}”.`
            : "It found one that is close."
          : "Nothing like it yet. It stands alone, for now.",
        small: first ? `Closest: ${first.star.text}` : "The next one like it will join it.",
      });
      setChosen(star.id);
      motion.heat = Math.max(motion.heat, 0.3);
      if (calm) {
        for (let r = 0; r < 160; r++) sky.relax(0.3 * (1 - r / 160) + 0.03);
        motion.landed.set(star.id, motion.now);
        continue;
      }
      // Its lines wait until it has arrived.
      for (const l of sky.lines) if (l.a === star || l.b === star) motion.born.set(l.a.id + "|" + l.b.id, Infinity);
      const [tx] = at(star),
        { w, h } = size.current;
      motion.flights.push({
        star,
        // It appears along the top of the sky, on the far side from where it is going.
        from: [
          tx > w / 2 ? w * (0.06 + Math.random() * 0.3) : w * (0.64 + Math.random() * 0.3),
          h * (0.06 + Math.random() * 0.1),
        ],
        bend: (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 90),
        since: motion.now,
        trail: [],
      });
    }
    if (fresh.length === 0) keepPlaces(sky.places());
    // `key` stands for the ideas: which there are, and what they say.
  }, [key]);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(undefined), 7000);
    return () => clearTimeout(timer);
  }, [said]);

  // The canvas is as large as its box, and as sharp as the screen.
  useEffect(() => {
    const host = box.current,
      node = canvas.current;
    if (!host || !node) return;
    const style = getComputedStyle(host),
      read = (name: string) => style.getPropertyValue(name).trim();
    colours.current = {
      star: read("--sky-star"),
      tints: Array.from({ length: TINTS }, (_, i) => read("--sky-tint-" + i)),
      mono: read("--font-mono") || "monospace",
    };
    const fit = () => {
      const rect = host.getBoundingClientRect(),
        dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: rect.width, h: rect.height };
      node.width = Math.round(rect.width * dpr);
      node.height = Math.round(rect.height * dpr);
      node.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(fit);
    watch.observe(host);
    return () => watch.disconnect();
  }, []);

  const land = (flight: Flight) => {
    const { star } = flight,
      [x, y] = at(star);
    motion.landed.set(star.id, motion.now);
    motion.rings.push({ x, y, at: motion.now, tint: tintOf(star), reach: 70 });
    for (const k of sky.kin(star).slice(0, 4)) {
      const [kx, ky] = at(k.star);
      motion.rings.push({ x: kx, y: ky, at: motion.now + 0.25, tint: tintOf(k.star), reach: 26 });
    }
    for (const l of sky.lines)
      if (l.a === star || l.b === star) motion.born.set(l.a.id + "|" + l.b.id, motion.now + 0.15);
    // The whole constellation feels it arrive, and then settles around it, slowly.
    for (const member of star.home?.stars ?? []) if (member !== star) motion.stirred.set(member.id, motion.now + 0.05);
    motion.heat = Math.max(motion.heat, 0.55);
  };

  useFrame(
    (dt) => {
      const ctx = canvas.current?.getContext("2d"),
        { w, h } = size.current,
        { star: white, mono } = colours.current;
      if (!ctx || w === 0) return;
      const m = motion;
      m.now += dt;
      const t = m.now;
      // After a new idea, the whole sky shifts a little each frame until it is at rest again.
      if (m.heat > 0.004 && !calm) {
        sky.relax(m.heat * 0.16);
        m.heat *= 0.991;
        if (m.heat <= 0.004) keepPlaces(sky.places());
      }
      const flying = new Set(m.flights.map((f) => f.star));
      ctx.clearRect(0, 0, w, h);
      const lit = sky.stars.find((s) => s.id === (hover ?? chosen)),
        near = lit ? new Set([lit, ...sky.kin(lit).map((k) => k.star)]) : undefined;
      // Lines between ideas that are close; a new line draws itself in.
      for (const l of sky.lines) {
        const born = m.born.get(l.a.id + "|" + l.b.id) ?? -10,
          grown = calm ? 1 : Math.max(0, Math.min(1, (t - born) / 0.7));
        if (grown <= 0) continue;
        const [x1, y1] = at(l.a),
          [x2, y2] = at(l.b),
          strong = lit !== undefined && (l.a === lit || l.b === lit);
        ctx.strokeStyle = tintOf(l.a);
        ctx.globalAlpha = (near ? (strong ? 0.9 : hover ? 0.07 : 0.2) : 0.16 + l.s * 0.5) * grown;
        ctx.lineWidth = strong ? 1.3 : 0.8;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + (x2 - x1) * grown, y1 + (y2 - y1) * grown);
        ctx.stroke();
      }
      // Each constellation is named by the words its ideas share.
      ctx.font = `500 10px ${mono}`;
      ctx.textAlign = "center";
      for (const c of sky.constellations) {
        if (c.stars.length < 3 || !c.name) continue;
        const spots = c.stars.map(at);
        ctx.globalAlpha = near ? (lit && c.stars.includes(lit) ? 0.8 : hover ? 0.14 : 0.3) : 0.42;
        ctx.fillStyle = colours.current.tints[c.tint % TINTS] ?? white;
        ctx.fillText(
          c.name.toUpperCase(),
          spots.reduce((sum, p) => sum + p[0], 0) / spots.length,
          Math.max(...spots.map((p) => p[1])) + 24,
        );
      }
      for (const star of sky.stars) {
        if (flying.has(star)) continue;
        const [x, y] = at(star),
          dim = near !== undefined && !near.has(star),
          twinkle = calm ? 1 : 0.82 + 0.18 * Math.sin(t * star.pace + star.beat),
          arrived = m.landed.get(star.id),
          fresh = arrived === undefined ? 0 : Math.max(0, 1 - (t - arrived) / 2.4),
          r = star.size * (star === lit ? 1.7 : 1) * (1 + fresh * 0.4),
          glow = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
        glow.addColorStop(0, tintOf(star));
        glow.addColorStop(1, "transparent");
        ctx.globalAlpha = (dim ? (hover ? 0.05 : 0.12) : 0.2 + fresh * 0.18) * twinkle;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 7, 0, 6.2832);
        ctx.fill();
        // Pointing at a star hushes the rest; a star only chosen leaves the sky readable.
        ctx.globalAlpha = dim ? (hover ? 0.28 : 0.62) : twinkle;
        ctx.fillStyle = star === lit ? white : tintOf(star);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fill();
      }
      // A new idea crossing the sky, with its tail.
      for (const f of m.flights) {
        // Out of the flash slowly, fast across the sky, slow into its place; the place may be moving as the others
        // make room, so it flies to where that place is now.
        const k = Math.min(1, (t - f.since - 0.3) / 1.5),
          e = k <= 0 ? 0 : k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2,
          to = at(f.star),
          far = Math.hypot(to[0] - f.from[0], to[1] - f.from[1]) || 1,
          mid = [
            (f.from[0] + to[0]) / 2 - ((to[1] - f.from[1]) / far) * f.bend,
            (f.from[1] + to[1]) / 2 + ((to[0] - f.from[0]) / far) * f.bend,
          ] as const,
          x = (1 - e) ** 2 * f.from[0] + 2 * e * (1 - e) * mid[0] + e * e * to[0],
          y = (1 - e) ** 2 * f.from[1] + 2 * e * (1 - e) * mid[1] + e * e * to[1],
          flash = Math.max(0, 1 - (t - f.since) / 0.5);
        f.trail.push([x, y]);
        if (f.trail.length > 26) f.trail.shift();
        for (let i = 1; i < f.trail.length; i++) {
          const a = f.trail[i - 1]!,
            b = f.trail[i]!;
          ctx.globalAlpha = (i / f.trail.length) ** 2 * 0.9;
          ctx.strokeStyle = white;
          ctx.lineWidth = (i / f.trail.length) * 2.6;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        }
        const bloom = ctx.createRadialGradient(x, y, 0, x, y, 26 + flash * 60);
        bloom.addColorStop(0, white);
        bloom.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(x, y, 26 + flash * 60, 0, 6.2832);
        ctx.fill();
        if (k >= 1) land(f);
      }
      m.flights = m.flights.filter((f) => !m.landed.has(f.star.id));
      // Where it lands, a ring spreads and its kin answer.
      for (const ring of m.rings) {
        const k = (t - ring.at) / 1.1;
        if (k < 0 || k > 1) continue;
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.strokeStyle = ring.tint;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, 6 + k * ring.reach, 0, 6.2832);
        ctx.stroke();
      }
      m.rings = m.rings.filter((ring) => t - ring.at < 1.2);
      ctx.globalAlpha = 1;
    },
    true,
    key + "|" + (chosen ?? "") + "|" + (hover ?? ""),
  );

  const nearest = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return undefined;
    let best: Star | undefined,
      far = 18;
    for (const star of sky.stars) {
      const [x, y] = at(star),
        d = Math.hypot(x - (event.clientX - rect.left), y - (event.clientY - rect.top));
      if (d < far) [best, far] = [star, d];
    }
    return best;
  };
  const star = sky.stars.find((s) => s.id === chosen),
    idea = star && byId.get(star.id),
    kin = star ? sky.kin(star).slice(0, 4) : [],
    group = (star?.home?.stars ?? (star ? [star, ...kin.map((k) => k.star)] : []))
      .map((s) => byId.get(s.id))
      .filter((i): i is Idea => i !== undefined),
    pointed = sky.stars.find((s) => s.id === hover),
    tipAt = pointed ? at(pointed) : undefined,
    tip = tipAt && tipPlace(tipAt, size.current);
  return (
    <div className="vc-sky-wrap">
      <div className="vc-sky" ref={box}>
        <div className="vc-sky-aurora a1" />
        <div className="vc-sky-aurora a2" />
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${plural(ideas.length, terms.idea.toLowerCase())} as stars, ${plural(sky.constellations.length, "group")} of close ones. The list shows the same in words.`}
          onPointerMove={(event) => setHover(nearest(event)?.id)}
          onPointerLeave={() => setHover(undefined)}
          onClick={(event) => setChosen(nearest(event)?.id)}
        />
        <svg className="vc-sky-hills" viewBox="0 0 1200 90" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 62 Q 180 18 380 50 T 760 40 T 1200 58 V90 H0Z" />
          <path d="M0 80 Q 300 52 600 78 T 1200 72 V90 H0Z" />
        </svg>
        {pointed && tip && (
          <div className="vc-sky-tip" data-below={tip.below || undefined} style={{ left: tip.left, top: tip.top }}>
            <span>{pointed.text}</span>
            <small>{pointed.home?.name || (pointed.home ? "close ones" : "alone, for now")}</small>
          </div>
        )}
        {said && (
          <p className="vc-sky-said" role="status">
            {said.line}
            <small>{said.small}</small>
          </p>
        )}
      </div>
      {idea && star && (
        <div className="vc-sky-card">
          <p className="vc-label">{star.home?.name || (star.home ? "close ones" : "alone, for now")}</p>
          <p className="text">{idea.text}</p>
          <p className="vc-facts">{where(idea)}</p>
          {kin.length > 0 && (
            <ul className="near" aria-label="Closest">
              {kin.map((k) => (
                <li key={k.star.id}>
                  <button type="button" title={k.star.text} onClick={() => setChosen(k.star.id)}>
                    {k.star.text}
                  </button>
                  <i aria-hidden="true" style={{ ["--w" as string]: Math.round(Math.min(1, k.s * 2) * 100) + "%" }} />
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            {group.length > 1 && (
              <button type="button" className="vc-sky-go" onClick={() => onGather(group)}>
                New {terms.project.toLowerCase()} from these {group.length}
              </button>
            )}
            <button type="button" className="vc-link-button" onClick={() => onDraft(group.length > 1 ? group : [idea])}>
              Make a {terms.draft.toLowerCase()}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
