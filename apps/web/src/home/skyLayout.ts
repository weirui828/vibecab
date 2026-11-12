// The sky of ideas, as numbers: how close two ideas are, which lines join them into constellations, and where
// each star sits. Pure: the view draws it, and a test can look at every part.
//
// Closeness here is counted from the words two ideas share (rare words count more). It is a stand-in with one
// narrow door, `closeness`, so that embeddings can take its place without the rest changing.

export interface SkyIdea {
  id: string;
  text: string;
}
export interface Star {
  id: string;
  text: string;
  tokens: string[];
  x: number;
  y: number;
  size: number;
  beat: number;
  pace: number;
  /** The stars it is joined to by a line. */
  beside: Star[];
  home: Constellation | undefined;
  fx: number;
  fy: number;
}
export interface Line {
  a: Star;
  b: Star;
  s: number;
}
export interface Constellation {
  stars: Star[];
  /** Which tint it is drawn in: the largest constellation is 0. */
  tint: number;
  name: string;
}

const LINK = 0.14, // closer than this, two ideas may be joined
  LINES = 3, // each idea offers a line to its closest few
  EDGE = 0.17, // how long a line likes to be
  ROOM = 0.11; // no two stars closer than this

const stop = new Set(
  (
    "a an and are as at be by for from i in is it its let me my not of on once or so that the this to what when " +
    "which who with should each have has was were will can could just one two into out up down over than then"
  ).split(" "),
);
const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, "").replace(/(.)\1$/, "$1");

/** The parts of a text that can be shared with another: word stems, and pairs of characters where words are not spaced. */
export function tokens(text: string): string[] {
  const lower = text.toLowerCase(),
    found: string[] = [];
  for (const word of lower.match(/[a-z]+/g) ?? []) if (word.length > 2 && !stop.has(word)) found.push(stem(word));
  for (const run of lower.match(/[㐀-鿿぀-ヿ가-힯]+/g) ?? []) {
    if (run.length === 1) found.push(run);
    for (let i = 0; i + 1 < run.length; i++) found.push(run.slice(i, i + 2));
  }
  return found;
}

/** A small repeatable shuffle, so the same ideas always make the same sky. */
function shuffler(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Sky {
  stars: Star[] = [];
  lines: Line[] = [];
  constellations: Constellation[] = [];
  private weight = new Map<string, number>();
  private close = new Map<Star, Map<Star, number>>();
  private readonly rand: () => number;

  constructor(seed = 20261111) {
    this.rand = shuffler(seed);
  }

  /** How close two stars are, 0 to 1. */
  closeness(a: Star, b: Star): number {
    return this.close.get(a)?.get(b) ?? 0;
  }
  /** The stars close enough to be kin, closest first. */
  kin(star: Star): Array<{ star: Star; s: number }> {
    return this.stars
      .filter((other) => other !== star && this.closeness(star, other) >= LINK)
      .map((other) => ({ star: other, s: this.closeness(star, other) }))
      .sort((x, y) => y.s - x.s);
  }

  /**
   * Makes the sky hold exactly these ideas. Stars that stay keep their place; `places` gives a place to stars seen
   * before (from the last visit); a new star starts beside its kin, or in the emptiest patch if it has none.
   * Returns the stars that are new.
   */
  set(ideas: SkyIdea[], places: Record<string, [number, number]> = {}): Star[] {
    const old = new Map(this.stars.map((star) => [star.id, star])),
      fresh: Star[] = [],
      unplaced: Star[] = [];
    this.stars = ideas.map((idea) => {
      const kept = old.get(idea.id);
      if (kept) {
        kept.text = idea.text;
        kept.tokens = tokens(idea.text);
        return kept;
      }
      const place = places[idea.id],
        star: Star = {
          id: idea.id,
          text: idea.text,
          tokens: tokens(idea.text),
          x: place?.[0] ?? this.rand() * 1.6 - 0.8,
          y: place?.[1] ?? this.rand() * 1.3 - 0.7,
          size: 2.2 + this.rand() * 1.8,
          beat: this.rand() * 6.28,
          pace: 0.6 + this.rand() * 1.4,
          beside: [],
          home: undefined,
          fx: 0,
          fy: 0,
        };
      fresh.push(star);
      if (!place) unplaced.push(star);
      return star;
    });
    this.link();
    // A whole new sky is laid out from nothing; a newcomer to a standing sky is put beside its kin.
    if (unplaced.length === this.stars.length) this.layout();
    else for (const star of unplaced) this.place(star);
    return fresh;
  }

  /** Every star's place, to keep for the next visit. */
  places(): Record<string, [number, number]> {
    return Object.fromEntries(this.stars.map((s) => [s.id, [Number(s.x.toFixed(4)), Number(s.y.toFixed(4))]]));
  }

  private link(): void {
    const { stars } = this;
    // Rare words say more than common ones.
    const seen = new Map<string, number>();
    for (const star of stars) for (const t of new Set(star.tokens)) seen.set(t, (seen.get(t) ?? 0) + 1);
    this.weight = new Map([...seen].map(([t, n]) => [t, Math.log(1 + stars.length / n)]));
    const bag = (star: Star) => {
      const m = new Map<string, number>();
      for (const t of star.tokens) m.set(t, (m.get(t) ?? 0) + (this.weight.get(t) ?? 1));
      return m;
    };
    const bags = new Map(stars.map((star) => [star, bag(star)]));
    this.close = new Map(stars.map((star) => [star, new Map()]));
    for (let i = 0; i < stars.length; i++)
      for (let j = i + 1; j < stars.length; j++) {
        const a = stars[i]!,
          b = stars[j]!,
          x = bags.get(a)!,
          y = bags.get(b)!;
        let dot = 0,
          nx = 0,
          ny = 0;
        for (const [t, v] of x) {
          nx += v * v;
          dot += v * (y.get(t) ?? 0);
        }
        for (const v of y.values()) ny += v * v;
        const s = nx && ny ? dot / Math.sqrt(nx * ny) : 0;
        this.close.get(a)!.set(b, s);
        this.close.get(b)!.set(a, s);
      }
    // Lines worth drawing: from each idea to its closest few.
    const offered = new Map<string, Line>();
    for (const a of stars)
      for (const { star: b, s } of this.kin(a).slice(0, LINES)) {
        const [first, second] = stars.indexOf(a) < stars.indexOf(b) ? [a, b] : [b, a];
        offered.set(first.id + "|" + second.id, { a: first, b: second, s });
      }
    // A constellation is a tree of its strongest lines, so three stars never make a thin triangle.
    const group = new Map<Star, Star>(stars.map((star) => [star, star]));
    const root = (n: Star): Star => {
      const up = group.get(n)!;
      if (up === n) return n;
      const top = root(up);
      group.set(n, top);
      return top;
    };
    const tree: Line[] = [],
      spare: Line[] = [];
    for (const line of [...offered.values()].sort((x, y) => y.s - x.s)) {
      if (root(line.a) === root(line.b)) spare.push(line);
      else {
        group.set(root(line.a), root(line.b));
        tree.push(line);
      }
    }
    // A larger one gets a line or two more, closing a ring, but never between two stars that share a neighbour.
    const beside = (n: Star, among: Line[]) =>
      among.filter((l) => l.a === n || l.b === n).map((l) => (l.a === n ? l.b : l.a));
    const size = new Map<Star, number>(),
      rings = new Map<Star, number>();
    for (const star of stars) size.set(root(star), (size.get(root(star)) ?? 0) + 1);
    for (const line of spare) {
      const home = root(line.a),
        count = size.get(home) ?? 0,
        had = rings.get(home) ?? 0;
      if (count < 5 || had >= Math.floor(count / 4)) continue;
      if (beside(line.a, tree).some((n) => beside(line.b, tree).includes(n))) continue;
      tree.push(line);
      rings.set(home, had + 1);
    }
    this.lines = tree;
    for (const star of stars) star.beside = beside(star, tree);
    // Each constellation is named by the words its ideas share most; the largest comes first.
    const sets = new Map<Star, Star[]>();
    for (const star of stars) sets.set(root(star), [...(sets.get(root(star)) ?? []), star]);
    this.constellations = [...sets.values()]
      .filter((set) => set.length > 1)
      .sort((x, y) => y.length - x.length)
      .map((set, tint) => {
        const tally = new Map<string, number>();
        for (const star of set) for (const t of new Set(star.tokens)) tally.set(t, (tally.get(t) ?? 0) + 1);
        const name = [...tally]
          .filter(([, n]) => n > 1)
          .sort((x, y) => y[1] * (this.weight.get(y[0]) ?? 1) - x[1] * (this.weight.get(x[0]) ?? 1))
          .slice(0, 2)
          .map(([t]) => t)
          .join(" · ");
        return { stars: set, tint, name };
      });
    for (const star of stars) star.home = undefined;
    for (const c of this.constellations) for (const star of c.stars) star.home = c;
  }

  private place(star: Star): void {
    const friends = this.kin(star).slice(0, 3);
    if (friends.length) {
      const sum = friends.reduce((a, k) => a + k.s, 0);
      star.x = friends.reduce((a, k) => a + k.star.x * k.s, 0) / sum + (this.rand() - 0.5) * 0.08;
      star.y = friends.reduce((a, k) => a + k.star.y * k.s, 0) / sum + (this.rand() - 0.5) * 0.08;
      return;
    }
    // Nothing like it yet: it takes the emptiest patch of sky.
    let best = -1;
    for (let i = 0; i < 60; i++) {
      const x = this.rand() * 1.7 - 0.85,
        y = this.rand() * 1.3 - 0.75,
        room = Math.min(1, ...this.stars.filter((o) => o !== star).map((o) => Math.hypot(o.x - x, o.y - y)));
      if (room > best) [best, star.x, star.y] = [room, x, y];
    }
  }

  private layout(): void {
    for (let r = 0; r < 500; r++) this.relax(0.7 * (1 - r / 500) + 0.08);
    // The whole sky into the frame, wider than it is tall.
    const xs = this.stars.map((p) => p.x),
      ys = this.stars.map((p) => p.y),
      [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (this.stars.length > 1)
      for (const p of this.stars) {
        p.x = ((p.x - x0) / (x1 - x0 || 1)) * 1.7 - 0.85;
        p.y = ((p.y - y0) / (y1 - y0 || 1)) * 1.26 - 0.72;
      }
    for (let r = 0; r < 260; r++) this.relax(0.25 * (1 - r / 260) + 0.04);
    this.untangle();
    for (let r = 0; r < 120; r++) this.relax(0.06);
  }

  /**
   * One small step toward a sky that reads well. Run many times at the start, and a little each frame after a new
   * idea arrives, so the stars that were there shift slowly to make room for it.
   */
  relax(step: number): void {
    const { stars } = this;
    const push = (a: Star, b: Star, dx: number, dy: number, d: number, amount: number) => {
      a.fx += (dx / d) * amount;
      a.fy += (dy / d) * amount;
      b.fx -= (dx / d) * amount;
      b.fy -= (dy / d) * amount;
    };
    for (const p of stars) {
      // Lean toward the middle, and stay inside the frame.
      p.fx = -p.x * 0.004 + (p.x > 0.88 ? (0.88 - p.x) * 2 : p.x < -0.88 ? (-0.88 - p.x) * 2 : 0);
      p.fy = -p.y * 0.006 + (p.y > 0.58 ? (0.58 - p.y) * 2 : p.y < -0.76 ? (-0.76 - p.y) * 2 : 0);
    }
    for (let i = 0; i < stars.length; i++)
      for (let j = i + 1; j < stars.length; j++) {
        const a = stars[i]!,
          b = stars[j]!,
          s = this.closeness(a, b),
          dx = b.x - a.x || 0.001,
          dy = b.y - a.y || 0.001,
          d = Math.hypot(dx, dy),
          kin = s >= LINK,
          want = kin ? 0.2 + 0.3 * (1 - s) : 0.62;
        // Kin are held near; strangers are only pushed off when they come too close; nobody crowds anybody.
        push(a, b, dx, dy, d, kin ? (d - want) * 0.08 : d < want ? (d - want) * 0.2 : (d - want) * 0.0012);
        if (d < ROOM) push(a, b, dx, dy, d, (d - ROOM) * 0.9);
      }
    for (const l of this.lines) {
      const dx = l.b.x - l.a.x || 0.001,
        dy = l.b.y - l.a.y || 0.001,
        d = Math.hypot(dx, dy);
      // Lines of about one length make a constellation, not a tangle.
      push(l.a, l.b, dx, dy, d, (d - EDGE) * 0.35);
      // A star that sits almost on a line it is not part of is moved off it, and the line away from the star.
      for (const c of l.a.home?.stars ?? []) {
        if (c === l.a || c === l.b) continue;
        const t = Math.max(0.08, Math.min(0.92, ((c.x - l.a.x) * dx + (c.y - l.a.y) * dy) / (d * d))),
          ox = c.x - (l.a.x + dx * t),
          oy = c.y - (l.a.y + dy * t),
          off = Math.hypot(ox, oy) || 0.001;
        if (off > 0.08) continue;
        const away = (0.08 - off) * 0.6,
          nx = off < 0.002 ? -dy / d : ox / off,
          ny = off < 0.002 ? dx / d : oy / off;
        c.fx += nx * away;
        c.fy += ny * away;
        for (const end of [l.a, l.b]) {
          end.fx -= nx * away * 0.5;
          end.fy -= ny * away * 0.5;
        }
      }
    }
    // Two lines that cross are pulled apart, each to its own side.
    for (const [k, l] of this.crossings()) {
      const dx = (l.a.x + l.b.x - k.a.x - k.b.x) / 2 || 0.001,
        dy = (l.a.y + l.b.y - k.a.y - k.b.y) / 2 || 0.001,
        d = Math.hypot(dx, dy),
        // Crossed through their middles, there is no "own side" yet: slide one along the other.
        ux = d < 0.02 ? (k.b.x - k.a.x) / EDGE : dx / d,
        uy = d < 0.02 ? (k.b.y - k.a.y) / EDGE : dy / d;
      for (const end of [l.a, l.b]) {
        end.fx += ux * 0.03;
        end.fy += uy * 0.03;
      }
      for (const end of [k.a, k.b]) {
        end.fx -= ux * 0.03;
        end.fy -= uy * 0.03;
      }
    }
    // Two lines leaving one star open out, so they never run side by side.
    for (const hub of stars)
      for (let i = 0; i < hub.beside.length; i++)
        for (let j = i + 1; j < hub.beside.length; j++) {
          const a = hub.beside[i]!,
            b = hub.beside[j]!,
            dx = b.x - a.x || 0.001,
            dy = b.y - a.y || 0.001,
            d = Math.hypot(dx, dy);
          if (d < 0.21) push(a, b, dx, dy, d, (d - 0.21) * 0.35);
        }
    for (const p of stars) {
      p.x += Math.max(-0.03, Math.min(0.03, p.fx * step));
      p.y += Math.max(-0.03, Math.min(0.03, p.fy * step));
    }
  }

  /** The pairs of lines that cross each other (lines that share a star do not count). */
  crossings(): Array<[Line, Line]> {
    const turn = (p: Star, q: Star, r: Star) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const found: Array<[Line, Line]> = [];
    for (let i = 0; i < this.lines.length; i++)
      for (let j = i + 1; j < this.lines.length; j++) {
        const k = this.lines[i]!,
          l = this.lines[j]!;
        if (k.a === l.a || k.a === l.b || k.b === l.a || k.b === l.b) continue;
        if (turn(k.a, k.b, l.a) !== turn(k.a, k.b, l.b) && turn(l.a, l.b, k.a) !== turn(l.a, l.b, k.b))
          found.push([k, l]);
      }
    return found;
  }

  /** Where two lines cross, try two of their stars the other way round, and keep it if fewer cross. */
  private untangle(): void {
    const swap = (p: Star, q: Star) => {
      [p.x, q.x] = [q.x, p.x];
      [p.y, q.y] = [q.y, p.y];
    };
    for (let tries = 0; tries < 24; tries++) {
      const crossed = this.crossings(),
        first = crossed[0];
      if (!first) return;
      const [k, l] = first;
      let best = crossed.length,
        pick: [Star, Star] | undefined;
      for (const [p, q] of [
        [k.a, l.a],
        [k.a, l.b],
        [k.b, l.a],
        [k.b, l.b],
      ] as Array<[Star, Star]>) {
        swap(p, q);
        const left = this.crossings().length;
        if (left < best) [best, pick] = [left, [p, q]];
        swap(p, q);
      }
      if (!pick) return;
      swap(pick[0], pick[1]);
      for (let r = 0; r < 60; r++) this.relax(0.12);
    }
  }
}

const TIP_HALF = 140;

/** Where a star's label goes: above the star, or below it when the star is in the upper half, so the label never leaves the sky. */
export function tipPlace(at: readonly [number, number], size: { w: number; h: number }) {
  const left = Math.max(TIP_HALF, Math.min(size.w - TIP_HALF, at[0]));
  return { left, top: at[1], below: at[1] < size.h / 2 };
}
