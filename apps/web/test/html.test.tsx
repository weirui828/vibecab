import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Element } from "../../../contract/generated/index.js";
import { frameDocument, isHtmlDraft, readFrameMessage } from "../src/document/htmlFrame.js";
import { slotFinder } from "../src/session/threads.js";
import { draftFramePolicy, draftFrameShell } from "../server/draft-frame.js";

// An HTML Draft in the web app (task H1): what goes into its frame, what the page believes of what comes out,
// and the frame page's own policy. A real browser checks the frame itself (e2e/html.spec.ts).

let dom: JSDOM, tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent"] as const;
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

const id = (n: number) => "el_" + String(n).padStart(26, "0");
const elements: Element[] = [
  {
    elementId: id(1),
    type: "html_head",
    parentId: null,
    order: "a0",
    props: { htmlAttrs: [["lang", "en"]], bodyAttrs: [["class", "wide"]] },
    html: "<title>T</title><style>p{color:teal}</style>",
  },
  {
    elementId: id(2),
    type: "html_node",
    parentId: null,
    order: "a1",
    props: { tag: "main", attrs: [["class", "page"]] },
  },
  { elementId: id(3), type: "html_block", parentId: id(2), order: "a0", props: {}, html: '<h1 class="big">Title</h1>' },
  { elementId: id(4), type: "html_block", parentId: id(2), order: "a1", props: {}, html: "<p>Words & more</p>" },
];
const known = new Set([id(3), id(4)]);

it("builds the frame's document: the file itself, each block tagged, the reporter first in the head", () => {
  const doc = frameDocument(elements, "tok-1");
  expect(doc.startsWith('<!DOCTYPE html><html lang="en"><head><script>')).toBe(true);
  // The Draft's own head follows the reporter, and its body keeps its wrapper and attributes.
  expect(doc.indexOf("</script><title>T</title><style>p{color:teal}</style></head>")).toBeGreaterThan(0);
  expect(doc).toContain('<body class="wide">');
  expect(doc).toContain('<main class="page">');
  expect(doc).toContain(`<h1 data-vc-el="${id(3)}" class="big">Title</h1>`);
  expect(doc).toContain(`<p data-vc-el="${id(4)}">Words & more</p>`);
  // Nodes and the head are not places a comment can sit.
  expect(doc.match(/data-vc-el=/g)).toHaveLength(2);
  expect(doc).toContain('"tok-1"');
  expect(isHtmlDraft(elements)).toBe(true);
  expect(isHtmlDraft([])).toBe(false);
});

it("believes only messages that carry the frame's token, and only about blocks it knows", () => {
  const block = { id: id(3), top: 10, left: 0, width: 300, height: 40 };
  expect(readFrameMessage({ vc: "tok-1", type: "layout", height: 500.2, blocks: [block] }, "tok-1", known)).toEqual({
    type: "layout",
    height: 501,
    blocks: [block],
  });
  // No token, the wrong token, the wrong shape: nothing.
  for (const bad of [
    null,
    "x",
    {},
    { type: "layout", height: 1, blocks: [] },
    { vc: "other", type: "layout", height: 1, blocks: [] },
  ])
    expect(readFrameMessage(bad, "tok-1", known)).toBeUndefined();
  expect(readFrameMessage({ vc: "tok-1", type: "layout", height: "tall", blocks: [] }, "tok-1", known)).toBeUndefined();
  // Blocks the Draft does not have, or with numbers that are not numbers, are dropped; the height is capped.
  const odd = readFrameMessage(
    {
      vc: "tok-1",
      type: "layout",
      height: 9e9,
      blocks: [{ ...block, id: "el_unknown" }, { ...block, top: "1" }, block],
    },
    "tok-1",
    known,
  );
  expect(odd).toEqual({ type: "layout", height: 60_000, blocks: [block] });
  expect(readFrameMessage({ vc: "tok-1", type: "hover", id: id(4) }, "tok-1", known)).toEqual({
    type: "hover",
    id: id(4),
  });
  expect(readFrameMessage({ vc: "tok-1", type: "hover", id: "el_unknown" }, "tok-1", known)).toEqual({
    type: "hover",
    id: null,
  });
});

it("gives every html block its own place for threads, not its wrapper's", () => {
  const slot = slotFinder(elements);
  expect(slot(id(3))).toBe(id(3));
  expect(slot(id(4))).toBe(id(4));
});

it("shows an HTML Draft in a closed frame, hands it the file once it is ready, and lays a box over each block", async () => {
  const { DocumentView } = await import("../src/document/DocumentView.js");
  const { container } = tl.render(<DocumentView elements={elements} blobUrl={(hash) => hash} />);
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/draft-frame");
  expect(container.querySelector(".vc-doc h1")).toBeNull(); // nothing of the file is drawn in the app's own page
  const sent: Array<{ vcDraft?: boolean; html?: string }> = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
    (message: unknown) => void sent.push(message as never),
  );
  const say = (data: unknown) =>
    tl.act(() => void window.dispatchEvent(new dom.window.MessageEvent("message", { data })));
  say({ vcFrame: "ready" });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.vcDraft).toBe(true);
  const token = /var token = "([^"]+)"/.exec(sent[0]?.html ?? "")?.[1] ?? "";
  expect(token.length).toBeGreaterThan(20);
  const layout = { type: "layout", height: 640, blocks: [{ id: id(3), top: 20, left: 8, width: 600, height: 50 }] };
  say({ ...layout, vc: "not-the-token" });
  expect(container.querySelectorAll(".vc-html-block")).toHaveLength(0);
  say({ ...layout, vc: token });
  const box = container.querySelector<HTMLElement>(".vc-html-block")!;
  expect(box.dataset.elementId).toBe(id(3));
  expect(box.style.top).toBe("20px");
  expect(frame.style.height).toBe("640px");
  // The pointer over a block inside the frame reaches the page as a move over that block's box.
  let moved = 0;
  box.addEventListener("mousemove", () => moved++);
  say({ vc: token, type: "hover", id: id(3) });
  expect(moved).toBe(1);
  expect(box.hasAttribute("data-hover")).toBe(true);
});

it("gives the frame page a policy of its own: no network, no forms, an origin of its own, and scripts only inline", () => {
  const rules = Object.fromEntries(
    draftFramePolicy.split("; ").map((rule) => [rule.split(" ")[0], rule.split(" ").slice(1).join(" ")]),
  );
  expect(rules["default-src"]).toBe("'none'");
  expect(rules["sandbox"]).toBe("allow-scripts");
  expect(rules["script-src"]).toBe("'unsafe-inline'");
  expect(rules["frame-ancestors"]).toBe("'self'");
  expect(rules["form-action"]).toBe("'none'");
  expect(rules["connect-src"]).toBeUndefined(); // falls back to default-src: none
  for (const value of Object.values(rules)) expect(value).not.toMatch(/https?:|\*/);
  // The empty page asks for nothing from outside and takes the Draft only from the page that holds it.
  expect(draftFrameShell).not.toMatch(/src=|href=|https?:/);
  expect(draftFrameShell).toContain("event.source !== parent");
});
