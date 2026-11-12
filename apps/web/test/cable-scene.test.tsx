import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionRow } from "../src/live/workspace.js";

// The session's cable, frame by frame. The test owns the clock: frames come only when it sends them.

let dom: JSDOM, tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "Event"] as const;
let pending: FrameRequestCallback[] = [],
  now = 0;
/** Sends `count` frames, a sixtieth of a second apart. */
function frames(count: number) {
  tl.act(() => {
    for (let i = 0; i < count; i++) {
      now += 1000 / 60;
      const due = pending;
      pending = [];
      for (const callback of due) callback(now);
    }
  });
}
beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  Object.assign(dom.window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => pending.push(callback),
    cancelAnimationFrame: () => (pending = []),
  });
  Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });
  tl = await import("@testing-library/react");
});
afterEach(() => {
  tl.cleanup();
  pending = [];
});
afterAll(() => {
  dom.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

const session = { sessionId: "s", title: "S", state: "active", artifactIds: [] } as unknown as SessionRow;

function read(container: HTMLElement) {
  const cab = /translate\(([\d.-]+) ([\d.-]+)\) rotate\(([\d.-]+)\)/.exec(
      container.querySelector(".vc-cab")?.getAttribute("transform") ?? "",
    ),
    numbers = (selector: string, name: string) =>
      [...container.querySelectorAll(selector)].map((node) => Number(node.getAttribute(name)));
  return {
    x: Number(cab?.[1]),
    y: Number(cab?.[2]),
    lean: Number(cab?.[3]),
    gripX: numbers(".vc-grip", "cx"),
    gripY: numbers(".vc-grip", "cy"),
    cable: container.querySelector("path.vc-cable:not(.tail)")?.getAttribute("d") ?? "",
    reached: [...container.querySelectorAll(".vc-station:not(.ahead) .vc-sign text")].map((node) => node.textContent),
  };
}
/** The drawn cable's height at x, read back from its path. */
function cableAt(d: string, x: number): number {
  const points = [...d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    if (a[0] <= x && x <= b[0] && b[0] > a[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return Number.NaN;
}

it("hangs the cab on the cable, sends it out with an Update, and lands it on the new version", async () => {
  const { CableScene } = await import("../src/session/CableScene.js");
  const scene = (head: number, running: boolean) => (
    <CableScene session={session} head={head} running={running} open={1} agreed={1} />
  );
  const view = tl.render(scene(1, false));
  frames(30);
  const rest = read(view.container);
  expect(rest.x).toBeCloseTo(590, 1);
  expect(rest.reached).toEqual(["v1"]);
  expect(tl.screen.getByRole("status").textContent).toContain("At version 1. ready. 1 open.");

  // The Update starts: the cab leaves slowly, then moves faster, and leans back while it gathers speed.
  view.rerender(scene(1, true));
  frames(20);
  const leaving = read(view.container);
  expect(leaving.x - rest.x).toBeGreaterThan(0);
  expect(leaving.x - rest.x).toBeLessThan(6);
  frames(60);
  const under = read(view.container);
  expect(under.x - leaving.x).toBeGreaterThan(30);
  expect(under.lean).toBeGreaterThan(1);
  // On the way it is on the cable itself: the cab's point and both grips sit on the drawn line.
  expect(under.y).toBeCloseTo(cableAt(under.cable, under.x), 1);
  under.gripX.forEach((x, i) => expect(under.gripY[i]! + 1.6).toBeCloseTo(cableAt(under.cable, x), 0));
  expect(tl.screen.getByRole("status").textContent).toContain("en route");

  // It never passes the next station while the work is still running, however long that takes.
  frames(60 * 60);
  expect(read(view.container).x).toBeLessThan(590 + 420 * 0.85);

  // Version 2 lands: the cab brakes into its station, and the line is renumbered around it.
  view.rerender(scene(2, false));
  frames(60 * 3);
  await tl.waitFor(() => expect(read(view.container).reached.at(-1)).toBe("v2"));
  frames(60 * 4);
  const arrived = read(view.container);
  expect(arrived.x).toBeCloseTo(590, 0);
  expect(Math.abs(arrived.lean)).toBeLessThan(2);
  expect(arrived.reached).toEqual(["v1", "v2"]);
});

it("makes each station a way to its version, and lights the cab's window while the agent works", async () => {
  const { CableScene, VIEW_VERSION } = await import("../src/session/CableScene.js");
  const asked: number[] = [];
  const onAsk = (event: Event) => asked.push((event as CustomEvent<{ version: number }>).detail.version);
  window.addEventListener(VIEW_VERSION, onAsk);
  const view = tl.render(<CableScene session={session} head={3} running={false} open={0} agreed={0} working />);
  frames(5);
  // Versions 1 to 3 are stations to go to; the one ahead is not there yet.
  const names = tl.screen.getAllByRole("button").map((sign) => sign.getAttribute("aria-label"));
  expect(names).toEqual(["v1: show this version", "v2: show this version", "v3: the latest version"]);
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "v2: show this version" }));
  tl.fireEvent.keyDown(tl.screen.getByRole("button", { name: "v3: the latest version" }), { key: "Enter" });
  expect(asked).toEqual([2, 3]);
  window.removeEventListener(VIEW_VERSION, onAsk);
  // The light is on only while there is work.
  expect(view.container.querySelector(".vc-cab")?.hasAttribute("data-working")).toBe(true);
  view.rerender(<CableScene session={session} head={3} running={false} open={0} agreed={0} />);
  expect(view.container.querySelector(".vc-cab")?.hasAttribute("data-working")).toBe(false);
});

it("brings the cab back to its station when an Update stops without a new version", async () => {
  const { CableScene } = await import("../src/session/CableScene.js");
  const scene = (running: boolean) => <CableScene session={session} head={3} running={running} open={0} agreed={0} />;
  const view = tl.render(scene(true));
  frames(60 * 3);
  expect(read(view.container).x).toBeGreaterThan(640);
  view.rerender(scene(false));
  frames(60 * 4);
  const back = read(view.container);
  expect(back.x).toBeCloseTo(590, 0);
  expect(back.reached).toEqual(["v1", "v2", "v3"]);
  expect(tl.screen.getByRole("status").textContent).toContain("At version 3. clear. Nothing open.");
});
