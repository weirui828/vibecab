import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { skyAt } from "../src/ui/Horizon.js";

// The finish layer: the horizon that follows the hour, counts that show a change, the gliding highlight, and the
// page boundary that keeps one broken page from blanking the app.

let dom: JSDOM, tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "Event"] as const;
beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
});
afterEach(() => tl.cleanup());
afterAll(() => {
  dom.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

it("puts the sun in the sky by day and the moon by night, each along its arc", () => {
  const at = (h: number, m = 0) => skyAt(new Date(2026, 5, 1, h, m));
  expect(at(5, 30)).toEqual({ body: "sun", t: 0 });
  expect(at(12, 30)).toEqual({ body: "sun", t: 0.5 });
  expect(at(19, 29).body).toBe("sun");
  expect(at(19, 30)).toEqual({ body: "moon", t: 0 });
  expect(at(0, 30)).toEqual({ body: "moon", t: 0.5 });
  expect(at(5, 29).body).toBe("moon");
  for (const hour of [0, 3, 6, 9, 12, 15, 18, 21, 23]) {
    const { t } = at(hour);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(1);
  }
});

it("draws the horizon as decoration, with stars only at night", async () => {
  const { Horizon } = await import("../src/ui/Horizon.js");
  const night = tl.render(<Horizon now={new Date(2026, 5, 1, 23, 0)} />).container.querySelector("svg")!;
  expect(night.getAttribute("aria-hidden")).toBe("true");
  expect(night.getAttribute("data-sky")).toBe("moon");
  expect(night.querySelectorAll(".star").length).toBeGreaterThan(0);
  tl.cleanup();
  const day = tl.render(<Horizon now={new Date(2026, 5, 1, 10, 0)} />).container.querySelector("svg")!;
  expect(day.getAttribute("data-sky")).toBe("sun");
  expect(day.querySelectorAll(".star")).toHaveLength(0);
});

it("marks a count only when its number changes, not when it first shows", async () => {
  const { Count } = await import("../src/ui/Count.js");
  const view = tl.render(<Count value={3} />);
  const count = () => view.container.querySelector(".count")!;
  expect(count().textContent).toBe("3");
  expect(count().hasAttribute("data-bump")).toBe(false);
  view.rerender(<Count value={3} />);
  expect(count().hasAttribute("data-bump")).toBe(false);
  view.rerender(<Count value={4} />);
  await tl.waitFor(() => expect(count().hasAttribute("data-bump")).toBe(true));
  expect(count().textContent).toBe("4");
});

it("keeps the item's own highlight until the glider is placed, and stays out of the way of assistive tech", async () => {
  const { Glider } = await import("../src/ui/Glider.js");
  const { container } = tl.render(
    <nav>
      <Glider selector='[aria-current="page"]' />
      <a href="#/">Home</a>
      <a href="#/drafts" aria-current="page">
        Drafts
      </a>
    </nav>,
  );
  const glider = container.querySelector(".vc-glider")!;
  expect(glider.getAttribute("aria-hidden")).toBe("true");
  // jsdom lays nothing out, so there is nothing to measure: the glider stays off and the link keeps its highlight.
  expect(glider.hasAttribute("data-on")).toBe(false);
  expect(tl.screen.getAllByRole("link")).toHaveLength(2);
});

it("shows what happened when a page breaks, instead of a blank app", async () => {
  const { PageBoundary } = await import("../src/ui/PageBoundary.js");
  const Broken = (): never => {
    throw new Error("thread list is not iterable");
  };
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    tl.render(
      <div>
        <p>Sidebar</p>
        <PageBoundary>
          <Broken />
        </PageBoundary>
      </div>,
    );
    const alert = tl.screen.getByRole("alert");
    expect(alert.textContent).toContain("This page stopped.");
    expect(alert.textContent).toContain("thread list is not iterable");
    expect(tl.within(alert).getByRole("button", { name: "Load again" })).toBeTruthy();
    // What is outside the page is still there.
    expect(tl.screen.getByText("Sidebar")).toBeTruthy();
  } finally {
    quiet.mockRestore();
  }
});
