import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agreement, Element, Thread, Update } from "../../../contract/generated/index.js";
import { canDecide, startsIn, threadStatus } from "../src/session/loop.js";
import type { Loop } from "../src/session/loop.js";
import { planItems } from "../src/session/UpdateStrip.js";

const loop = (over: Partial<Loop> = {}): Loop => ({
  agreements: [],
  updates: [],
  current: undefined,
  latest: undefined,
  scheduledAt: undefined,
  conflicts: [],
  modelReady: true,
  planReview: false,
  autoAgree: false,
  agents: ["vibecab"],
  agent: "vibecab",
  ...over,
});
const thread = (comments: Array<Partial<Thread["comments"][number]>>): Thread =>
  ({
    threadId: "t",
    sessionId: "s",
    anchorResolutions: [],
    comments: comments.map((c, i) => ({
      commentId: "c" + i,
      author: { kind: "human" },
      body: "x",
      state: "open",
      deleted: false,
      ...c,
    })),
  }) as unknown as Thread;
const agreement = (state: string, commentId = "c0", agreementId = "a1") =>
  ({
    agreementId,
    commentId,
    kind: "as_written",
    state,
    agreedAt: "2026-11-07T00:00:00Z",
  }) as Loop["agreements"][number];

describe("thread status", () => {
  it("is nothing until someone decides", () => {
    expect(threadStatus(thread([{}]), loop())).toBeUndefined();
    expect(canDecide(thread([{}]), loop())).toBe(true);
  });

  it("follows the agreement through the loop", () => {
    const t = thread([{}, { author: { kind: "agent" } as never, appliedInVersion: 3 }]);
    expect(threadStatus(t, loop({ agreements: [agreement("agreed")] }))?.text).toBe(
      "Agreed — waiting for the next Update",
    );
    const running = { updateId: "u", itemIds: ["a1"], status: "writing" } as unknown as Loop["current"];
    expect(threadStatus(t, loop({ agreements: [agreement("agreed")], current: running }))?.text).toBe("In an Update");
    const other = { updateId: "u", itemIds: ["zz"], status: "writing" } as unknown as Loop["current"];
    expect(threadStatus(t, loop({ agreements: [agreement("agreed")], current: other }))?.text).toBe(
      "Agreed — will go into the next Update",
    );
    expect(threadStatus(t, loop({ agreements: [agreement("applied", "c1")] }))).toMatchObject({
      text: "Applied in version 3",
      appliedIn: 3,
    });
    expect(canDecide(t, loop({ agreements: [agreement("agreed")] }))).toBe(false);
  });

  it("says why an agreed change was not applied, and flags conflicts first", () => {
    const t = thread([{}]);
    const missed = {
      updateId: "u",
      itemIds: ["a1"],
      status: "committed",
      createdAt: "2026-11-07T00:00:00Z",
      itemResults: [{ itemId: "a1", status: "not_addressed", reason: "The text moved" }],
    } as unknown as Loop["updates"][number];
    expect(threadStatus(t, loop({ agreements: [agreement("agreed")], updates: [missed] }))?.text).toBe(
      "Not applied: The text moved",
    );
    const conflict = {
      conflictId: "x",
      itemIds: ["a1", "a2"],
      stage: "deterministic",
      state: "open",
    } as Loop["conflicts"][number];
    expect(threadStatus(t, loop({ agreements: [agreement("agreed")], conflicts: [conflict] }))?.text).toBe(
      "Conflicts with another agreed change",
    );
  });

  it("shows a decline with its reason", () => {
    const t = thread([{ state: "declined", declineReason: "Too long" }]);
    expect(threadStatus(t, loop())?.text).toBe("Declined: Too long");
    expect(canDecide(t, loop())).toBe(false);
  });
});

it("words the Update countdown", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  expect(startsIn("2026-11-07T12:00:03Z", now)).toBe("now");
  expect(startsIn("2026-11-07T12:00:40Z", now)).toBe("in 40 s");
  expect(startsIn("2026-11-07T12:12:00Z", now)).toBe("in 12 min");
  expect(startsIn("2026-11-07T14:00:00Z", now)).toBe("in 2 h");
  expect(startsIn(undefined, now)).toBeUndefined();
});

it("reads the planner's items and ignores anything malformed", () => {
  expect(
    planItems({ items: [{ itemId: "a1", action: "edit", elementIds: ["e1", 7], note: "Tighten" }, { nope: 1 }, "x"] }),
  ).toEqual([{ itemId: "a1", action: "edit", elementIds: ["e1"], note: "Tighten" }]);
  expect(planItems(null)).toEqual([]);
});

describe("changes view", () => {
  let dom: JSDOM, tl: typeof import("@testing-library/react");
  beforeAll(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
    for (const key of ["window", "document", "navigator", "HTMLElement", "Node"] as const)
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
    tl = await import("@testing-library/react");
  });
  afterAll(() => {
    tl?.cleanup();
    dom.window.close();
    for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
      Reflect.deleteProperty(globalThis, key);
  });

  it("marks every kind of change with words and symbols, not colour alone", async () => {
    const { DocumentView } = await import("../src/document/DocumentView.js");
    const p = (elementId: string, order: string, text: string): Element =>
      ({ elementId, order, parentId: null, type: "paragraph", props: {}, text }) as Element;
    const head = [
      p("kept", "a0", "Same."),
      p("edit", "a1", "Moss on basalt."),
      p("new", "a3", "A new line."),
      p("moved", "a4", "Moved."),
    ];
    const removed = [p("gone", "a2", "Old line.")];
    const { container } = tl.render(
      <DocumentView
        elements={head}
        blobUrl={(h) => h}
        diff={{
          result: {
            added: ["new"],
            removed: ["gone"],
            changed: ["edit"],
            moved: ["moved"],
            textDiffs: {
              edit: [
                { value: "Moss on " },
                { value: "rock", removed: true },
                { value: "basalt", added: true },
                { value: "." },
              ],
            },
          },
          removed,
        }}
      />,
    );
    const order = [...container.querySelectorAll(".vc-doc > *")].map(
      (n) => n.getAttribute("data-element-id") ?? n.querySelector("[data-element-id]")?.getAttribute("data-element-id"),
    );
    expect(order).toEqual(["kept", "edit", "gone", "new", "moved"]);
    expect(container.querySelector("ins")?.textContent).toBe("added: basalt");
    expect(container.querySelector("del")?.textContent).toBe("removed: rock");
    const labels = [...container.querySelectorAll(".vc-change-label")].map((n) => n.textContent);
    expect(labels).toEqual(["Changed", "New", "Moved"]);
    expect(container.querySelector(".vc-removed summary")?.textContent).toContain("Removed paragraph");
  });
});

describe("change history", () => {
  const update = (id: string, version: number | undefined, results: Array<[string, string[]]>) =>
    ({
      updateId: id,
      artifactId: "a",
      baseVersion: 1,
      itemIds: results.map(([item]) => item),
      status: version ? "committed" : "failed",
      itemResults: results.map(([itemId, elementIds]) => ({ itemId, status: "addressed", elementIds })),
      createdAt: `2026-11-0${version ?? 9}T00:00:00.000Z`,
      ...(version ? { resultVersion: version } : {}),
    }) as unknown as Update;
  const agreement = (id: string, instruction: string) =>
    ({
      agreementId: id,
      commentId: "c-" + id,
      kind: "as_written",
      instruction,
      state: "applied",
    }) as unknown as Agreement;
  // "li" is a list item inside list "ul"; "p" is a paragraph.
  const slotOf = (id: string) => ({ p: "p", ul: "ul", li: "li", text: "li" })[id];

  it("lists only the Updates that changed the block, oldest first, with what asked for each", async () => {
    const { historyEntries, changedBlocks } = await import("../src/session/ChangeHistory.js");
    const updates = [
      update("u3", 3, [["g2", ["p"]]]),
      update("u2", 2, [["g1", ["p", "li"]]]),
      update("u4", undefined, [["g3", ["p"]]]), // never wrote a version: not history
    ];
    const agreements = [agreement("g1", "Shorter."), agreement("g2", "Name it."), agreement("g3", "Never applied.")];
    expect([...changedBlocks(updates, slotOf)].sort()).toEqual(["li", "p"]);
    const entries = historyEntries("p", updates, agreements, [], slotOf);
    expect(entries.map((e) => [e.version, e.asks.map((a) => a.text)])).toEqual([
      [2, ["Shorter."]],
      [3, ["Name it."]],
    ]);
    expect(historyEntries("ul", updates, agreements, [], slotOf)).toEqual([]);
  });
});
