import { expect, it } from "vitest";
import { along, isStill, makeString, pluck, rideTable, stepString, swing, waveAt } from "../src/ui/lineMotion.js";
import { lineReason, lineShape } from "../src/home/SessionLines.js";
import { statusWord } from "../src/session/CableScene.js";
import { lean } from "../src/shell/wind.js";
import { starPlace } from "../src/home/HomeScene.js";
import { beadsOf } from "../src/session/PlumbLine.js";
import type { AttentionItem } from "../../../contract/generated/index.js";
import type { SessionRow } from "../src/live/workspace.js";

// The line's numbers: a ride that starts and stops gently, a string that rings and settles, a cab that swings.

it("rides out of a station gently, cruises, and brakes into the next", () => {
  const table = rideTable(5.4, 1.5, 1.9);
  expect(along(table, 0)).toBe(0);
  expect(along(table, 1)).toBeCloseTo(1, 6);
  const step = (at: number) => along(table, at + 0.01) - along(table, at);
  // Slow at both ends, fastest in between, and never backwards.
  expect(step(0)).toBeLessThan(step(0.5) / 20);
  expect(step(0.98)).toBeLessThan(step(0.5) / 20);
  for (let at = 0; at < 0.99; at += 0.01) expect(step(at)).toBeGreaterThanOrEqual(0);
  // In the middle the speed is steady.
  expect(step(0.45)).toBeCloseTo(step(0.55), 6);
});

it("rings when plucked, keeps its ends fixed, and settles", () => {
  const line = makeString(61);
  expect(isStill(line)).toBe(true);
  pluck(line, 0.5, 6);
  expect(waveAt(line, 0.5)).toBeCloseTo(6, 1);
  expect(waveAt(line, 0)).toBe(0);
  expect(waveAt(line, 1)).toBe(0);
  for (let frame = 0; frame < 30; frame++) stepString(line);
  expect(isStill(line)).toBe(false);
  // The pluck has spread: it is no longer one bump in the middle.
  expect(Math.abs(waveAt(line, 0.5))).toBeLessThan(6);
  for (let frame = 0; frame < 1500; frame++) stepString(line);
  expect(isStill(line)).toBe(true);
  expect(line.u[0]).toBe(0);
  expect(line.u[line.n - 1]).toBe(0);
});

it("swings the cab back when the line pulls away and lets it come to rest", () => {
  const cab = { theta: 0, omega: 0 };
  for (let frame = 0; frame < 30; frame++) swing(cab, 1 / 60, 1.2);
  expect(cab.theta).toBeGreaterThan(0.02);
  for (let frame = 0; frame < 900; frame++) swing(cab, 1 / 60, 0);
  expect(Math.abs(cab.theta)).toBeLessThan(0.001);
});

it("leans a hanging line only while a gust blows, and never at its ends", () => {
  expect(lean({ level: 0, clock: 10, from: 0 }, 0.5)).toBe(0);
  const gust = { level: 1, clock: 3, from: 0 };
  expect(lean(gust, 0.5)).toBeGreaterThan(0.4);
  expect(lean(gust, 0)).toBe(0);
  expect(Math.abs(lean(gust, 1))).toBeLessThan(1e-9);
});

it("gives every idea its own star over Home, always in the same place, inside the sky", () => {
  const places = Array.from({ length: 60 }, (_, n) => starPlace(n));
  expect(starPlace(7)).toEqual(places[7]);
  for (const star of places) {
    expect(star.x).toBeGreaterThan(20);
    expect(star.x).toBeLessThan(1180);
    expect(star.y).toBeGreaterThan(5);
    expect(star.y).toBeLessThan(105);
  }
  // No two share a place.
  expect(new Set(places.map((star) => `${Math.round(star.x)},${Math.round(star.y)}`)).size).toBe(60);
});

it("lets a bead say what its thread says", () => {
  const thread = (state: string, body: string, elementId?: string) =>
    ({
      threadId: "t-" + body,
      anchorResolutions: [],
      comments: [
        {
          commentId: "c-" + body,
          body,
          state,
          deleted: false,
          author: { kind: "human" },
          ...(elementId ? { anchor: { artifactId: "a", elementId } } : {}),
        },
      ],
    }) as unknown as Parameters<typeof beadsOf>[0][number];
  expect(
    beadsOf([
      thread("open", "Say  which\nseason.", "el_1"),
      thread("agreed", "Shorter.", "el_2"),
      thread("applied", "Done.", "el_3"),
      thread("declined", "No.", "el_4"),
      thread("open", "On the whole session"),
    ]).map((bead) => [bead.elementId, bead.state, bead.said]),
  ).toEqual([
    ["el_1", "open", "Say which season."],
    ["el_2", "agreed", "Shorter."],
    ["el_3", "applied", "Done."],
  ]);
});

const session = (state: SessionRow["state"]): SessionRow =>
  ({ sessionId: "s", title: "S", state, replyTrigger: "manual", createdAt: "", artifactIds: [] }) as SessionRow;
const items = (...kinds: AttentionItem["kind"][]): AttentionItem[] => kinds.map((kind, i) => ({ kind, id: String(i) }));

it("gives a session's line a stop per version, the newest few, and one ahead while it can still change", () => {
  expect(lineShape(session("active"), 2, [])).toMatchObject({ first: 1, head: 2, next: true, moving: false });
  expect(lineShape(session("active"), 9, [])).toMatchObject({ first: 6, head: 9 });
  expect(lineShape(session("ended"), 3, []).next).toBe(false);
  // No Draft yet: nothing to ride to.
  expect(lineShape(session("active"), 0, [])).toMatchObject({ first: 0, head: 0, next: false });
  const busy = lineShape(session("active"), 2, items("running_update", "unread_reply", "proposal", "agreed_item"));
  expect(busy).toMatchObject({ moving: true, open: 2, agreed: 1 });
});

it("says in words why a session stands where it does", () => {
  expect(lineReason(session("active"), [])).toBe("Nothing is waiting.");
  expect(lineReason(session("paused"), [])).toMatch(/^Paused\./);
  expect(lineReason(session("ended"), [])).toMatch(/^Ended\./);
  expect(lineReason(session("active"), items("unread_reply"))).toBe("A new reply.");
});

it("words the board from the session's state first, then the work", () => {
  expect(statusWord("ended", true, 1, 1)).toBe("ENDED");
  expect(statusWord("paused", false, 0, 0)).toBe("PAUSED");
  expect(statusWord("active", true, 2, 0)).toBe("EN ROUTE");
  expect(statusWord("active", false, 2, 3)).toBe("READY");
  expect(statusWord("active", false, 0, 3)).toBe("WAITING");
  expect(statusWord("active", false, 0, 0)).toBe("CLEAR");
});
