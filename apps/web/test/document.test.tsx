import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Element } from "../../../contract/generated/index.js";
import { catchUpLines, catchUpSummary } from "../src/session/CatchUp.js";
import { safeHref } from "../src/document/InlineText.js";
import { parseSessionRoute } from "../src/session/SessionView.js";

let dom: JSDOM;
let tl: typeof import("@testing-library/react");
beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"] as const)
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
});
afterAll(() => {
  tl?.cleanup();
  dom?.window.close();
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"]) Reflect.deleteProperty(globalThis, key);
});

const el = (e: Partial<Element> & Pick<Element, "elementId" | "type">, order = "a0"): Element =>
  ({ parentId: null, order, props: {}, ...e }) as Element;

// One of every doc element type, nested where the type allows it, inserted out of order.
const fixture: Element[] = [
  el(
    {
      elementId: "p1",
      type: "paragraph",
      text: "Body with **bold**, *italic*, `code` and [a link](https://example.com).",
    },
    "a1",
  ),
  el({ elementId: "h1", type: "heading", props: { level: 1 }, text: "Title" }, "a0"),
  el({ elementId: "l1", type: "list", props: { ordered: true } }, "a2"),
  el({ elementId: "li2", type: "list_item", parentId: "l1", text: "Second" }, "a1"),
  el({ elementId: "li1", type: "list_item", parentId: "l1", text: "First" }, "a0"),
  el({ elementId: "l2", type: "list", parentId: "li1", props: { ordered: false } }, "a0"),
  el({ elementId: "li3", type: "list_item", parentId: "l2", text: "Nested" }, "a0"),
  el({ elementId: "q1", type: "quote", text: "A quote" }, "a3"),
  el({ elementId: "c1", type: "code_block", props: { language: "ts" }, text: "const a = 1 < 2;" }, "a4"),
  el({ elementId: "t1", type: "table", props: { headerRow: true } }, "a5"),
  el({ elementId: "tr1", type: "table_row", parentId: "t1" }, "a0"),
  el({ elementId: "tr2", type: "table_row", parentId: "t1" }, "a1"),
  el({ elementId: "td1", type: "table_cell", parentId: "tr1", text: "Head" }, "a0"),
  el({ elementId: "td2", type: "table_cell", parentId: "tr2", text: "Cell" }, "a0"),
  el({ elementId: "i1", type: "image", props: { alt: "A tussock", caption: "Moss" }, blobHash: "a".repeat(64) }, "a6"),
  el({ elementId: "d1", type: "divider" }, "a7"),
  el({ elementId: "co1", type: "callout", props: { tone: "warning" }, text: "Careful" }, "a8"),
];

async function renderDoc(elements: Element[]) {
  tl.cleanup();
  const { DocumentView } = await import("../src/document/DocumentView.js");
  return tl.render(<DocumentView elements={elements} blobUrl={(h) => "/v1/blobs/" + h} />);
}

describe("DocumentView", () => {
  it("renders every doc element type in order, with data-element-id on each", async () => {
    const { container } = await renderDoc(fixture);
    for (const e of fixture)
      expect(container.querySelector(`[data-element-id="${e.elementId}"]`), e.elementId).not.toBeNull();
    const doc = container.querySelector(".vc-doc")!;
    expect([...doc.children].map((n) => n.getAttribute("data-element-id"))).toEqual([
      "h1",
      "p1",
      "l1",
      "q1",
      "c1",
      "t1",
      "i1",
      "d1",
      "co1",
    ]);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect([...container.querySelectorAll("ol > li")].map((li) => li.firstChild?.textContent)).toEqual([
      "First",
      "Second",
    ]);
    expect(container.querySelector("ol > li ul > li")?.textContent).toBe("Nested");
    expect(container.querySelector("thead th")?.textContent).toBe("Head");
    expect(container.querySelector("tbody td")?.textContent).toBe("Cell");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/v1/blobs/" + "a".repeat(64));
    expect(container.querySelector("figcaption")?.textContent).toBe("ts");
    expect(container.querySelector(".vc-callout")?.getAttribute("data-tone")).toBe("warning");
    expect(container.querySelector('.vc-callout [aria-label="Warning"]')).not.toBeNull();
    expect(container.querySelector("p strong")?.textContent).toBe("bold");
    expect(container.querySelector("p a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders unsafe links and HTML in text as plain text", async () => {
    const { container } = await renderDoc([
      el({
        elementId: "x",
        type: "paragraph",
        text: "[click](javascript:alert(1)) <img src=x onerror=alert(1)> <b>no</b>",
      }),
    ]);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("says so when the Document is empty", async () => {
    const { container } = await renderDoc([]);
    expect(container.textContent).toBe("Nothing written yet.");
  });

  it("renders long Documents in batches", async () => {
    const many = Array.from({ length: 700 }, (_, i) =>
      el({ elementId: "p" + i, type: "paragraph", text: "Line " + i }, "a" + String(i).padStart(4, "0")),
    );
    const { container } = await renderDoc(many);
    expect(container.querySelectorAll(".vc-doc > p")).toHaveLength(300);
  });
});

it("allows only http, https and mailto links", () => {
  expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
  expect(safeHref("javascript:alert(1)")).toBeUndefined();
  expect(safeHref("data:text/html,hi")).toBeUndefined();
  expect(safeHref("/relative")).toBeUndefined();
});

it("parses session routes with and without a Draft", () => {
  expect(parseSessionRoute("/s/session_1")).toEqual({ sessionId: "session_1" });
  expect(parseSessionRoute("/s/session_1/d/art_2")).toEqual({ sessionId: "session_1", artifactId: "art_2" });
  expect(parseSessionRoute("/drafts")).toBeUndefined();
});

it("lists catch-up items once and summarises them in one line", () => {
  const resume = {
    sessionId: "s",
    fromSeq: 1,
    toSeq: 9,
    versions: [{ artifactId: "a", version: 3, changeCount: 2 }],
    comments: [
      { commentId: "c1", author: { kind: "human" }, body: "Tighter", anchor: { elementId: "e1" } },
      { commentId: "c2", author: { kind: "system" }, body: "Applied in version 3." },
    ],
    replies: [{ commentId: "r1", author: { kind: "agent" }, body: "Done" }],
    awaitingAgreement: [{}],
    conflicts: [],
    updates: [],
    changesSinceOutputSet: [],
  };
  expect(catchUpSummary(resume)).toBe("version 3 · 1 reply · 1 comment · 1 to agree");
  const lines = catchUpLines(resume);
  expect(lines.map((l) => l.text)).toEqual([
    "Version 3 · 2 changes",
    "The agent replied: “Done”",
    "You commented: “Tighter”",
    "1 item waiting for you to agree",
  ]);
  expect(lines.find((l) => l.key === "cc1")?.elementId).toBe("e1");
});
