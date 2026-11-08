import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";

const globals = ["window", "document", "navigator", "HTMLElement", "Node"] as const;
let dom: JSDOM;
let tl: typeof import("@testing-library/react");
beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
});
afterAll(() => {
  tl?.cleanup();
  dom?.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

it("draws cost per day as bars against the costliest day, names each for screen readers, and has a table", async () => {
  const { CostPerDay } = await import("../src/settings/UsageSection.js");
  const { container } = tl.render(
    <CostPerDay
      days={[
        { key: "2026-11-06", costMicros: 2_000_000, calls: 4, tokens: 12_000 },
        { key: "2026-11-07", costMicros: 0, calls: 0, tokens: 0 },
        { key: "2026-11-08", costMicros: 500_000, calls: 1, tokens: 1_500 },
      ]}
    />,
  );
  const bars = [...container.querySelectorAll<HTMLElement>(".bar")].map((b) => b.style.height);
  expect(bars).toEqual(["100%", "0%", "25%"]);
  const day = tl.screen.getByRole("img", { name: /: \$0\.50, 1 calls$/ });
  // Focus (or hover) shows the day's figures.
  tl.fireEvent.focus(day);
  expect(day.textContent).toContain("1 calls · 2K tokens");
  tl.fireEvent.blur(day);
  expect(day.querySelector(".vc-tip")).toBeNull();
  expect(tl.screen.getByRole("table").textContent).toContain("$2.00");
});
