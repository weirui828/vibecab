import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { ActionBar } from "../src/session/ActionBar.js";
import type { ThreadLayout } from "../src/session/ActionBar.js";
import { defaultFilter } from "../src/session/threads.js";

// The Threads button is the layout control: its icon and name say how threads show, and its menu changes it.

let dom: JSDOM, tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "Event", "KeyboardEvent"] as const;
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

function bar(over: Partial<ComponentProps<typeof ActionBar>> = {}) {
  const chosen: ThreadLayout[] = [];
  const props: ComponentProps<typeof ActionBar> = {
    canComment: true,
    threadCount: 6,
    unreadCount: 0,
    onNextUnread: () => undefined,
    layout: "below",
    filter: defaultFilter,
    onComment: () => undefined,
    onLayout: (layout) => chosen.push(layout),
    onFilter: () => undefined,
    replyMode: "manual",
    modelReady: true,
    onReplyMode: () => undefined,
    agents: [],
    agent: undefined,
    onAgent: () => undefined,
    onAsk: () => undefined,
    onHistory: () => undefined,
    onSnapshot: () => undefined,
    marginFits: true,
    ...over,
  };
  return { ...tl.render(<ActionBar {...props} />), chosen };
}

it("names the layout and the count on the Threads button, with an icon for each layout", () => {
  for (const [layout, name] of [
    ["below", "Threads: under each block, 6 threads"],
    ["beside", "Threads: beside the text, 6 threads"],
    ["hidden", "Threads: hidden, 6 threads"],
  ] as const) {
    bar({ layout });
    const button = tl.screen.getByRole("button", { name });
    expect(button.getAttribute("data-layout")).toBe(layout);
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.textContent).toBe("6");
    tl.cleanup();
  }
  // Three different pictures, one per layout.
  const icons = (["below", "beside", "hidden"] as const).map((layout) => {
    const { container } = bar({ layout });
    const svg = container.querySelector(`[data-layout="${layout}"] svg`)?.outerHTML;
    tl.cleanup();
    return svg;
  });
  expect(new Set(icons).size).toBe(3);
  bar({ threadCount: 0 });
  expect(tl.screen.getByRole("button", { name: "Threads: under each block, no threads" })).toBeTruthy();
});

it("opens a Show threads menu with three choices, the current one checked, and closes on a choice", () => {
  const { chosen } = bar({ layout: "beside" });
  const button = tl.screen.getByRole("button", { name: /^Threads:/ });
  tl.fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const menu = tl.screen.getByRole("menu", { name: "Show threads" });
  const items = tl.within(menu).getAllByRole("menuitemradio");
  expect(items.map((i) => [i.textContent, i.getAttribute("aria-checked")])).toEqual([
    ["Under each block", "false"],
    ["Beside the text", "true"],
    ["Hidden", "false"],
  ]);
  // Focus starts on the current choice, and the arrow keys move between choices.
  expect(document.activeElement).toBe(items[1]);
  tl.fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[2]);
  tl.fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[0]);
  tl.fireEvent.click(items[2]!);
  expect(chosen).toEqual(["hidden"]);
  expect(tl.screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(button);
});

it("keeps Beside the text in the menu when the window is narrow, and says why threads stay under each block", () => {
  bar({ layout: "beside", marginFits: false });
  tl.fireEvent.click(tl.screen.getByRole("button", { name: /^Threads:/ }));
  const menu = tl.within(tl.screen.getByRole("menu", { name: "Show threads" }));
  expect(menu.getByRole("menuitemradio", { name: "Beside the text" })).toBeTruthy();
  expect(menu.getByText("The margin needs a wider window. Until then, threads show under each block.")).toBeTruthy();
});

it("leaves only filtering in the funnel", () => {
  bar();
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Filter threads" }));
  const panel = tl.within(tl.screen.getByRole("dialog", { name: "Filter threads" }));
  expect(panel.queryByText("Under each block")).toBeNull();
  expect(panel.queryByText("Beside the text")).toBeNull();
  expect(panel.getByRole("button", { name: "Agent" })).toBeTruthy();
});
