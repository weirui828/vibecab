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
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Filter threads" }));
  const filter = await tl.screen.findByRole("dialog", { name: "Filter threads" });
  tl.fireEvent.click(tl.within(filter).getByRole("button", { name: "Agent" }));
  await tl.waitFor(() => expect(container.querySelectorAll(".vc-margin .vc-thread").length).toBe(1));
  expect(container.querySelector(".vc-margin .vc-thread")?.textContent).toContain("Name the rock.");
});
