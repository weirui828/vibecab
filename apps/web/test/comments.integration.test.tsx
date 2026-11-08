import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webBridge } from "../src/bridge/webBridge.js";
import type { WebBridge } from "../src/bridge/webBridge.js";
import type { Thread } from "../src/session/threads.js";
import { startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

// The scripted model (apps/web/dev/fake-provider.json) answers the first reply turn with
// "Covibe: two ways to make the title carry the idea." and two proposals.
let t: TestHost, dom: JSDOM, bridge: WebBridge, sessionId: string, artifactId: string;
let tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "Event"] as const;

async function command<T>(type: string, payload: unknown): Promise<T> {
  const result = await bridge.command(type, payload);
  if (!result.ok) throw new Error(result.error.message);
  return result.result as T;
}
const threads = () => bridge.query<Thread[]>("vc.Threads", { sessionId });

beforeAll(async () => {
  t = await startTestHost();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  // These tests cover threads in the margin beside the text; threads under each block have their own tests.
  localStorage.setItem("vc-comments", "beside");
  tl = await import("@testing-library/react");
  bridge = webBridge({ base: t.host.url, fetch: t.fetch, retryMs: 50 });
  const model = {
    provider: "openai-compatible",
    baseUrl: "https://example.invalid/v1",
    model: "scripted",
    capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 8192, reportsUsage: false },
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  };
  artifactId = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Field notes",
      format: "markdown",
      content: "# Field notes\n\nMoss on **basalt** near the lake.\n\nA second paragraph.",
    })
  ).artifactId;
  sessionId = (
    await command<{ sessionId: string }>("vc.StartSession", { title: "Tundra walk", replyTrigger: "realtime" })
  ).sessionId;
  await command("vc.AttachArtifact", { sessionId, artifactId, role: "primary" });
  await command("sys.SetSettings", {
    patch: { models: { default: model }, sessions: { [sessionId]: { realtimeDebounceSeconds: 1 } } },
  });
  await command("sys.SetBudget", { account: { kind: "daily" }, limitMicros: 2_000_000 });
}, 60_000);
afterAll(async () => {
  tl?.cleanup();
  await t?.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  dom?.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

async function openSession() {
  tl.cleanup();
  window.location.hash = "/s/" + sessionId;
  const { App } = await import("../src/App.js");
  const view = tl.render(<App bridge={bridge} />);
  await tl.waitFor(() => expect(view.container.querySelector(".vc-doc h1")?.textContent).toBe("Field notes"));
  // Commenting turns on once the Draft's version is known (anchors must name the version they were made on).
  await tl.screen.findByRole("button", { name: "Comment on the whole session" }, { timeout: 5000 });
  return view;
}

async function send(container: HTMLElement, label: string, body: string) {
  const form = await tl.waitFor(() => {
    const found = container.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`);
    if (!found) throw new Error("no composer " + label);
    return found;
  });
  tl.fireEvent.change(tl.within(form).getByLabelText(label), { target: { value: body } });
  tl.fireEvent.click(tl.within(form).getByRole("button", { name: /^(Comment|Reply|Save)$/ }));
}

it("comments on selected words with an exact anchor, and the agent's reply arrives live in the margin", async () => {
  const { container } = await openSession();
  const text = container.querySelector<HTMLElement>("[data-text-for] strong")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, "basalt".length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  const pick = await tl.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>(".vc-pick");
    if (!button) throw new Error("no Comment button by the selection");
    return button;
  });
  tl.fireEvent.click(pick);
  await send(container, "Comment on the selected words", "Name the rock.");
  await tl.waitFor(async () => {
    const [thread] = await threads();
    expect(thread?.comments[0]?.anchor).toMatchObject({
      artifactId,
      seenVersion: 1,
      locator: { quote: "basalt", prefix: "Moss on ", suffix: " near the lake." },
    });
  });
  await tl.waitFor(() => expect(container.querySelector(".vc-margin")?.textContent).toContain("Name the rock."));
  expect(container.querySelector(".vc-margin .quote")?.textContent).toBe("basalt");
  await tl.waitFor(
    () =>
      expect(container.querySelector(".vc-margin")?.textContent).toContain(
        "Covibe: two ways to make the title carry the idea.",
      ),
    { timeout: 15_000 },
  );
  // The agent's words are never a button label: option buttons say only "Agree" (W4).
  const marginButtons = [...(container.querySelector(".vc-margin") as HTMLElement).querySelectorAll("button")];
  expect(marginButtons.some((b) => b.textContent?.includes("Name the idea"))).toBe(false);
});

it("comments on a whole block and on the whole session", async () => {
  const { container } = await openSession();
  const paragraph = container.querySelectorAll<HTMLElement>(".vc-doc > p")[1]!;
  tl.fireEvent.mouseMove(paragraph);
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Comment on this block" }));
  await send(container, "Comment on this block", "Cut this paragraph.");
  await tl.waitFor(() => expect(container.querySelector('form[aria-label="Comment on this block"]')).toBeNull());
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Comment on the whole session" }));
  await send(container, "Comment on the whole session", "Keep it to one screen.");
  await tl.waitFor(async () => {
    const all = await threads(),
      block = all.find((th) => th.comments[0]?.body === "Cut this paragraph."),
      general = all.find((th) => th.comments[0]?.body === "Keep it to one screen.");
    expect(block?.comments[0]?.anchor?.elementId).toBe(paragraph.dataset.elementId);
    expect(block?.comments[0]?.anchor?.locator).toBeUndefined();
    expect(general).toBeDefined();
    expect(general?.comments[0]?.anchor).toBeUndefined();
  });
  await tl.waitFor(() => expect(container.querySelector(".vc-margin")?.textContent).toContain("On the whole session"));
});

it("keeps a block's buttons reachable: a rail inside the Document spans the gap and the block's height", async () => {
  const { container } = await openSession();
  const paragraph = container.querySelectorAll<HTMLElement>(".vc-doc > p")[1]!;
  // jsdom has no layout: give the block a tall box, as a long paragraph would have.
  paragraph.getBoundingClientRect = () =>
    ({ top: 100, bottom: 340, left: 0, right: 600, width: 600, height: 240, x: 0, y: 100 }) as DOMRect;
  tl.fireEvent.mouseMove(paragraph);
  const rail = container.querySelector<HTMLElement>(".vc-gutter-rail");
  // Inside the element that hides the buttons on mouse leave, so crossing to them never counts as leaving.
  expect(rail?.closest(".vc-surface-doc")).not.toBeNull();
  expect(rail?.style.height).toBe("240px");
  // Moving over the rail itself keeps the buttons up.
  tl.fireEvent.mouseMove(rail!);
  expect(tl.screen.getByRole("button", { name: "Comment on this block" })).toBeTruthy();
  expect(tl.screen.getByRole("button", { name: "Why is this here?" })).toBeTruthy();
});

it("replies, edits and deletes in a thread", async () => {
  const { container } = await openSession();
  const card = await tl.waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>(".vc-margin .vc-thread")].find((c) =>
      c.textContent?.includes("Cut this paragraph."),
    );
    if (!found) throw new Error("no card");
    return found;
  });
  tl.fireEvent.click(tl.within(card).getByRole("button", { name: "Reply" }));
  await send(card, "Reply", "Or shorten it to one line.");
  const bodies = () => [...card.querySelectorAll(".vc-comment .body")].map((p) => p.textContent);
  await tl.waitFor(() => expect(bodies()).toContain("Or shorten it to one line."));
  const [firstMenu] = tl.within(card).getAllByRole("button", { name: "Comment actions" });
  tl.fireEvent.click(firstMenu!);
  tl.fireEvent.click(await tl.within(card).findByRole("menuitem", { name: "Edit" }));
  await send(card, "Edit comment", "Cut this paragraph entirely.");
  await tl.waitFor(() => expect(bodies()).toContain("Cut this paragraph entirely."));
  const menus = tl.within(card).getAllByRole("button", { name: "Comment actions" });
  tl.fireEvent.click(menus.at(-1)!);
  tl.fireEvent.click(await tl.within(card).findByRole("menuitem", { name: "Delete" }));
  tl.fireEvent.click(tl.within(card).getByRole("button", { name: "Delete" }));
  await tl.waitFor(async () => {
    const all = await bridge.query<Thread[]>("vc.Threads", { sessionId, includeDeleted: true });
    const thread = all.find((th) => th.comments[0]?.body === "Cut this paragraph entirely.");
    expect(thread?.comments.find((c) => c.body === "Or shorten it to one line.")?.deleted).toBe(true);
  });
  await tl.waitFor(() => expect(bodies()).not.toContain("Or shorten it to one line."));
});

it("filters threads to those the agent answered", async () => {
  const { container } = await openSession();
  await tl.waitFor(() => expect(container.querySelectorAll(".vc-margin .vc-thread").length).toBe(3));
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Thread options" }));
  const filter = await tl.screen.findByRole("dialog", { name: "Thread options" });
  tl.fireEvent.click(tl.within(filter).getByRole("button", { name: "Agent" }));
  await tl.waitFor(() => expect(container.querySelectorAll(".vc-margin .vc-thread").length).toBe(1));
  expect(container.querySelector(".vc-margin .vc-thread")?.textContent).toContain("Name the rock.");
});

it("shows threads under each block, as covibe does: a click on a block opens a comment right below it", async () => {
  localStorage.setItem("vc-comments", "below");
  try {
    const { container } = await openSession();
    expect(container.querySelector(".vc-margin")).toBeNull();
    const paragraph = container.querySelectorAll<HTMLElement>(".vc-doc > p")[1]!,
      id = paragraph.dataset.elementId!;
    // Existing threads sit right after the block they are about.
    await tl.waitFor(() => {
      const below = paragraph.nextElementSibling as HTMLElement | null;
      expect(below?.classList.contains("vc-inline")).toBe(true);
      expect(below?.dataset.inlineFor).toBe(id);
      expect(below?.textContent).toContain("Cut this paragraph entirely.");
    });
    // A plain click on the block opens the composer in that same place.
    tl.fireEvent.click(paragraph.querySelector(".vc-text")!, { detail: 1 });
    const form = await tl.waitFor(() => {
      const found = paragraph.nextElementSibling?.querySelector<HTMLFormElement>(
        'form[aria-label="Comment on this block"]',
      );
      if (!found) throw new Error("no composer under the block");
      return found;
    });
    await send(form.parentElement!, "Comment on this block", "Say where the lake is.");
    await tl.waitFor(() => expect(paragraph.nextElementSibling?.textContent).toContain("Say where the lake is."));
    // A comment on the whole session shows above the Document.
    tl.fireEvent.click(tl.screen.getByRole("button", { name: "Comment on the whole session" }));
    const first = container.querySelector(".vc-surface-doc")!.firstElementChild as HTMLElement;
    expect(first.classList.contains("vc-inline")).toBe(true);
    expect(first.querySelector('form[aria-label="Comment on the whole session"]')).not.toBeNull();
    // The margin is one choice away, and remembered.
    tl.fireEvent.click(tl.screen.getByRole("button", { name: "Thread options" }));
    const options = await tl.screen.findByRole("dialog", { name: "Thread options" });
    tl.fireEvent.click(tl.within(options).getByRole("button", { name: "Beside the text" }));
    await tl.waitFor(() =>
      expect(container.querySelector(".vc-margin")?.textContent).toContain("Say where the lake is."),
    );
    expect(container.querySelector(".vc-inline .vc-comment")).toBeNull();
    expect(localStorage.getItem("vc-comments")).toBe("beside");
  } finally {
    localStorage.setItem("vc-comments", "beside");
  }
});

it("an ended session says why it cannot take comments, and carries on in a new session", async () => {
  const ended = (await command<{ sessionId: string }>("vc.StartSession", { title: "Last summer" })).sessionId;
  await command("vc.AttachArtifact", { sessionId: ended, artifactId, role: "primary" });
  await command("vc.EndSession", { sessionId: ended });
  tl.cleanup();
  window.location.hash = "/s/" + ended;
  const { App } = await import("../src/App.js");
  const { container } = tl.render(<App bridge={bridge} />);
  const note = await tl.screen.findByRole("note");
  expect(note.textContent).toContain("has ended");
  expect(tl.screen.queryByRole("button", { name: "Comment on the whole session" })).toBeNull();
  tl.fireEvent.click(tl.within(note).getByRole("button", { name: "Continue in a new session" }));
  await tl.waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/s/session_\\w+/d/${artifactId}$`)));
  const next = window.location.hash.split("/")[2]!;
  expect(next).not.toBe(ended);
  const drafts = await bridge.query<Array<{ artifactId: string; role?: string }>>("vc.Artifacts", { sessionId: next });
  expect(drafts.map((d) => [d.artifactId, d.role])).toEqual([[artifactId, "primary"]]);
  await tl.findByRole(container, "button", { name: "Comment on the whole session" }, { timeout: 5000 });
});

it("marks the agent's new replies until they are looked at, and walks to them from the bar", async () => {
  const unread = async () =>
    (await threads()).flatMap((th) => th.comments.filter((c) => c.author.kind === "agent" && !c.read && !c.deleted));
  // The agent answered "Name the rock." in the first test; nobody has opened that thread since.
  expect((await unread()).length).toBeGreaterThan(0);
  const { container } = await openSession();
  await tl.waitFor(() => expect(container.querySelector(".vc-thread[data-unread]")).not.toBeNull());
  expect(container.querySelector(".vc-thread[data-unread] .vc-new-tag")?.textContent).toContain("click to mark read");
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: /new repl(y|ies) ↓$/ }));
  await tl.waitFor(async () => expect(await unread()).toEqual([]));
  await tl.waitFor(() => expect(container.querySelector(".vc-thread[data-unread]")).toBeNull());
  expect(tl.screen.queryByRole("button", { name: /new repl(y|ies) ↓$/ })).toBeNull();
  // Needs you no longer counts them.
  const inbox = await bridge.query<Array<{ kind: string; sessionId?: string }>>("vc.AttentionInbox", {});
  expect(inbox.filter((i) => i.kind === "unread_reply" && i.sessionId === sessionId)).toEqual([]);
});

it("sends a quick mark in one click, with any words typed after it", async () => {
  const { container } = await openSession();
  const paragraph = container.querySelectorAll<HTMLElement>(".vc-doc > p")[1]!;
  tl.fireEvent.mouseMove(paragraph);
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Comment on this block" }));
  const form = await tl.screen.findByRole("form", { name: "Comment on this block" });
  tl.fireEvent.change(tl.within(form).getByLabelText("Comment on this block"), {
    target: { value: "The second half." },
  });
  tl.fireEvent.click(tl.within(form).getByRole("button", { name: "Explain" }));
  await tl.waitFor(async () =>
    expect((await threads()).flatMap((th) => th.comments.map((c) => c.body))).toContain(
      "Explain this in more detail. The second half.",
    ),
  );
});
