import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { Element, Thread } from "../../../contract/generated/index.js";
import { inlineMarkdownToPlainText, locateQuote } from "../../../contract/src/inline-markdown.js";
import { locatorForTextSelection } from "../../ui/src/document/anchors.js";
import { layoutMargin } from "../src/session/marginLayout.js";
import { rangeForOffsets, selectionInElement } from "../src/session/textRanges.js";
import { applyFilter, deliveryLabel, sortByPosition, threadsForDraft } from "../src/session/threads.js";

// Two text elements rendered the way DocumentView renders them: inline markup inside a [data-text-for] container.
function page() {
  const dom = new JSDOM(
    `<p data-element-id="e1"><span data-text-for="e1">Moss on <strong>black</strong> basalt, <em>near</em> the lake.</span></p>` +
      `<p data-element-id="e2"><span data-text-for="e2">Second paragraph.</span></p>`,
  );
  const doc = dom.window.document,
    e1 = doc.querySelector<HTMLElement>('[data-text-for="e1"]')!,
    e2 = doc.querySelector<HTMLElement>('[data-text-for="e2"]')!;
  return { dom, doc, e1, e2 };
}

describe("selection to anchor", () => {
  it("counts plain-text offsets across inline markup and builds the exact locator", () => {
    const { doc, e1 } = page(),
      range = doc.createRange();
    const strong = e1.querySelector("strong")!.firstChild!,
      em = e1.querySelector("em")!.firstChild!;
    range.setStart(strong, 0); // "black"
    range.setEnd(em, 4); // ..."near"
    const selection = selectionInElement(range)!;
    const markdown = "Moss on **black** basalt, *near* the lake.";
    expect(inlineMarkdownToPlainText(markdown)).toBe(e1.textContent);
    // "Moss on " is 8 characters; "black basalt, near" is 18.
    expect(selection).toEqual({ elementId: "e1", start: 8, end: 26 });
    expect(locatorForTextSelection(markdown, selection.start, selection.end)).toEqual({
      quote: "black basalt, near",
      prefix: "Moss on ",
      suffix: " the lake.",
    });
  });

  it("clips a selection across two elements to the first", () => {
    const { doc, e1, e2 } = page(),
      range = doc.createRange();
    range.setStart(e1.querySelector("em")!.firstChild!, 0);
    range.setEnd(e2.firstChild!, 6);
    expect(selectionInElement(range)).toEqual({ elementId: "e1", start: 22, end: (e1.textContent ?? "").length });
  });

  it("keeps prefix and suffix to 32 characters", () => {
    const text = "a".repeat(50) + "QUOTE" + "b".repeat(50),
      locator = locatorForTextSelection(text, 50, 55);
    expect(locator).toEqual({ quote: "QUOTE", prefix: "a".repeat(32), suffix: "b".repeat(32) });
  });

  it("maps offsets back to a DOM range for highlighting", () => {
    const { e1 } = page();
    expect(rangeForOffsets(e1, 8, 26)?.toString()).toBe("black basalt, near");
    expect(rangeForOffsets(e1, 0, 4)?.toString()).toBe("Moss");
  });
});

describe("locateQuote (shared with the engine)", () => {
  it("prefers a unique context, then a unique quote, else nothing", () => {
    const plain = "the moss, the moss and the lake";
    expect(locateQuote(plain, { quote: "moss", prefix: "the ", suffix: " and" })).toEqual({ start: 14, end: 18 });
    expect(locateQuote(plain, { quote: "lake", prefix: "x", suffix: "y" })).toEqual({ start: 27, end: 31 });
    expect(locateQuote(plain, { quote: "moss", prefix: "", suffix: "" })).toBeUndefined();
  });
});

describe("margin layout", () => {
  it("keeps cards beside their text, never overlapping, loose ones last", () => {
    const tops = layoutMargin([
      { id: "a", anchorTop: 100, height: 80 },
      { id: "b", anchorTop: 120, height: 50 },
      { id: "general", anchorTop: undefined, height: 40 },
      { id: "c", anchorTop: 400, height: 60 },
    ]);
    expect(tops.get("a")).toBe(100);
    expect(tops.get("b")).toBe(192); // pushed below a (100 + 80 + 12)
    expect(tops.get("c")).toBe(400);
    expect(tops.get("general")).toBe(472);
  });

  it("puts the pinned card at its text and moves cards above out of the way", () => {
    const tops = layoutMargin(
      [
        { id: "a", anchorTop: 200, height: 100 },
        { id: "draft", anchorTop: 220, height: 80 },
      ],
      "draft",
    );
    expect(tops.get("draft")).toBe(220);
    expect((tops.get("a") ?? 0) + 100).toBeLessThanOrEqual(220 - 12);
  });
});

const el = (elementId: string, order: string, text: string, parentId: string | null = null): Element =>
  ({ elementId, order, parentId, type: "paragraph", props: {}, text }) as Element;
const thread = (id: string, opts: { elementId?: string; quote?: string; agent?: boolean; state?: string } = {}) =>
  ({
    threadId: id,
    sessionId: "s",
    anchorResolutions: opts.elementId ? [{ anchor: {}, state: "current" }] : [],
    comments: [
      {
        commentId: id + "c",
        author: { kind: "human" },
        body: "x",
        state: opts.state ?? "open",
        deleted: false,
        ...(opts.elementId
          ? {
              anchor: {
                artifactId: "a",
                elementId: opts.elementId,
                seenVersion: 1,
                ...(opts.quote ? { locator: { quote: opts.quote, prefix: "", suffix: "" } } : {}),
              },
            }
          : {}),
      },
      ...(opts.agent
        ? [{ commentId: id + "r", author: { kind: "agent" }, body: "y", state: "open", deleted: false }]
        : []),
    ],
  }) as unknown as Thread;

describe("threads", () => {
  const elements = [el("p2", "a1", "Second about lake"), el("p1", "a0", "First about moss and sedge")];
  it("orders threads by place in the Document, then by quote position; general last", () => {
    const sorted = sortByPosition(
      [
        thread("general"),
        thread("lake", { elementId: "p2", quote: "lake" }),
        thread("sedge", { elementId: "p1", quote: "sedge" }),
        thread("moss", { elementId: "p1", quote: "moss" }),
      ],
      elements,
    );
    expect(sorted.map((t) => t.threadId)).toEqual(["moss", "sedge", "lake", "general"]);
  });

  it("keeps this Draft's threads and the general ones; filters by status, author and suggestion", () => {
    const other = thread("other", { elementId: "p1" });
    (other.comments[0]!.anchor as { artifactId: string }).artifactId = "b";
    const all = [
      thread("g"),
      thread("mine", { elementId: "p1" }),
      thread("agent", { elementId: "p1", agent: true }),
      other,
    ];
    expect(threadsForDraft(all, "a").map((t) => t.threadId)).toEqual(["g", "mine", "agent"]);
    const closed = thread("done", { state: "applied" });
    expect(applyFilter([closed, ...all], { status: "open", who: "everyone", suggestion: false })).not.toContain(closed);
    expect(applyFilter(all, { status: "all", who: "agent", suggestion: false }).map((t) => t.threadId)).toEqual([
      "agent",
    ]);
  });

  it("only says the agent is replying while its turn runs", () => {
    expect(deliveryLabel("queued", undefined)).toBe("Waiting for the agent");
    expect(deliveryLabel("delivered", "running")).toBe("The agent is replying…");
    expect(deliveryLabel("delivered", "completed")).toBeUndefined();
    expect(deliveryLabel("delivered", "failed")).toBe("The agent could not reply");
    expect(deliveryLabel("replied", "completed")).toBeUndefined();
  });
});
