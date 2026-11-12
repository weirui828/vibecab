import { expect, it } from "vitest";
import { Sky, tipPlace, tokens } from "../src/home/skyLayout.js";
import type { Star } from "../src/home/skyLayout.js";

// The sky of ideas as numbers: what joins what, and whether the picture it makes is a clean one.

const texts = [
  "A calmer first run with fewer steps before the first draft",
  "Let the first run skip the model setup and start with a sample draft",
  "Show a sample draft on first run so onboarding teaches by doing",
  "Onboarding checklist that disappears after the first run",
  "Comment on a sentence by selecting it, not the whole paragraph",
  "Voice notes as comments on a paragraph",
  "Let comments carry a suggested replacement sentence",
  "Show which comments are still open beside each paragraph",
  "Export a Snapshot as a PDF to send",
  "Share a Snapshot as a single link",
  "Export the draft with its comments as an appendix",
  "Polar night theme with a slow aurora",
  "A sound of wind when the theme changes to night",
  "Bake sourdough on Sundays",
];
const ideas = texts.map((text, i) => ({ id: "idea_" + i, text }));
const made = () => {
  const sky = new Sky();
  sky.set(ideas);
  return sky;
};
const between = (a: Star, b: Star) => Math.hypot(a.x - b.x, a.y - b.y);

it("splits a text into what can be shared: word stems, and character pairs where words are not spaced", () => {
  expect(tokens("Comments on the paragraphs, commenting")).toEqual(["comment", "paragraph", "comment"]);
  expect(tokens("导出快照")).toEqual(["导出", "出快", "快照"]);
  expect(tokens("The a of")).toEqual([]);
});

it("joins ideas that share rare words into named constellations, and leaves the odd one alone", () => {
  const sky = made(),
    home = (n: number) => sky.stars[n]!.home;
  expect(home(0)).toBeDefined();
  expect(home(0)).toBe(home(1));
  expect(home(4)).toBe(home(5));
  expect(home(8)).toBe(home(9));
  expect(home(0)).not.toBe(home(8));
  expect(sky.stars[13]!.home).toBeUndefined();
  for (const c of sky.constellations) {
    expect(c.stars.length).toBeGreaterThan(1);
    expect(c.name.length).toBeGreaterThan(0);
  }
  // The largest is first, and each has its own tint.
  expect(sky.constellations.map((c) => c.tint)).toEqual(sky.constellations.map((_, i) => i));
  // Closeness goes both ways, and is 0 to 1.
  const [a, b] = [sky.stars[0]!, sky.stars[1]!];
  expect(sky.closeness(a, b)).toBe(sky.closeness(b, a));
  expect(sky.closeness(a, b)).toBeGreaterThan(0);
  expect(sky.closeness(a, b)).toBeLessThanOrEqual(1);
});

it("draws a clean picture: no thin triangles, no crossing lines, nobody crowded, lines of about one length", () => {
  const sky = made();
  // Lines join kin only, inside one constellation.
  for (const l of sky.lines) expect(l.a.home).toBe(l.b.home);
  // No triangles: two stars that share a neighbour are not themselves joined.
  for (const l of sky.lines) expect(l.a.beside.some((n) => l.b.beside.includes(n))).toBe(false);
  expect(sky.crossings()).toEqual([]);
  for (let i = 0; i < sky.stars.length; i++)
    for (let j = i + 1; j < sky.stars.length; j++) expect(between(sky.stars[i]!, sky.stars[j]!)).toBeGreaterThan(0.08);
  for (const l of sky.lines) {
    expect(between(l.a, l.b)).toBeGreaterThan(0.09);
    expect(between(l.a, l.b)).toBeLessThan(0.32);
  }
  // Two lines leaving one star open out.
  for (const hub of sky.stars)
    for (let i = 0; i < hub.beside.length; i++)
      for (let j = i + 1; j < hub.beside.length; j++) {
        const angle = (n: Star) => Math.atan2(n.y - hub.y, n.x - hub.x);
        let open = (Math.abs(angle(hub.beside[i]!) - angle(hub.beside[j]!)) * 180) / Math.PI;
        if (open > 180) open = 360 - open;
        expect(open).toBeGreaterThan(25);
      }
  // Everything is inside the frame.
  for (const s of sky.stars) {
    expect(Math.abs(s.x)).toBeLessThan(0.95);
    expect(s.y).toBeGreaterThan(-0.85);
    expect(s.y).toBeLessThan(0.7);
  }
});

it("makes the same sky from the same ideas, and keeps it when it is told where the stars were", () => {
  const first = made(),
    second = made();
  expect(second.places()).toEqual(first.places());
  const third = new Sky(7);
  expect(third.set(ideas, first.places())).toHaveLength(ideas.length);
  expect(third.places()).toEqual(first.places());
});

it("puts a new idea beside its kin, leaves the others where they were, and lets them shift a little to make room", () => {
  const sky = made(),
    before = sky.places();
  const fresh = sky.set([...ideas, { id: "new", text: "Comments by voice while reading a paragraph on the phone" }]);
  expect(fresh.map((s) => s.id)).toEqual(["new"]);
  const star = fresh[0]!;
  expect(star.home).toBe(sky.stars[5]!.home);
  expect(sky.kin(star)[0]!.star.text).toBe("Voice notes as comments on a paragraph");
  expect(between(star, sky.stars[5]!)).toBeLessThan(0.3);
  // The standing stars have not jumped: each is where it was (to the precision a place is kept at).
  for (const s of sky.stars) {
    if (s === star) continue;
    expect(s.x).toBeCloseTo(before[s.id]![0], 3);
    expect(s.y).toBeCloseTo(before[s.id]![1], 3);
  }
  // A few seconds of small steps: they move, a little, and the picture is clean again.
  for (let frame = 0; frame < 400; frame++) sky.relax(0.06);
  const moved = sky.stars
    .filter((s) => s !== star)
    .map((s) => Math.hypot(s.x - before[s.id]![0], s.y - before[s.id]![1]));
  expect(Math.max(...moved)).toBeGreaterThan(0.005);
  expect(Math.max(...moved)).toBeLessThan(0.3);
  expect(sky.crossings()).toEqual([]);
  for (const other of sky.stars) if (other !== star) expect(between(star, other)).toBeGreaterThan(0.08);
  // One with no kin goes where there is room, and joins nothing.
  const [loner] = sky.set([...ideas, { id: "new", text: star.text }, { id: "odd", text: "Zebra xylophone quartet" }]);
  expect(loner!.home).toBeUndefined();
  expect(Math.min(...sky.stars.filter((s) => s !== loner).map((s) => between(s, loner!)))).toBeGreaterThan(0.15);
  // An idea that is removed leaves the sky.
  sky.set(ideas.slice(0, 5));
  expect(sky.stars).toHaveLength(5);
});

it("puts a star's label below it when the star is near the top, and keeps it inside the sides", () => {
  const size = { w: 800, h: 400 };
  expect(tipPlace([400, 30], size)).toEqual({ left: 400, top: 30, below: true });
  expect(tipPlace([400, 300], size)).toEqual({ left: 400, top: 300, below: false });
  expect(tipPlace([10, 300], size).left).toBe(140);
  expect(tipPlace([795, 300], size).left).toBe(660);
});
