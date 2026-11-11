import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webBridge } from "../src/bridge/webBridge.js";
import type { WebBridge } from "../src/bridge/webBridge.js";
import type { Agreement, FeedbackConflict, Update } from "../src/session/loop.js";
import { startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

// The scripted model (apps/web/dev/fake-provider.json), in order: 1–2 a reply with options "Name the idea" and
// "Keep it short"; 3–4 plan and write an Update (retitles the first element); 5–6 plan and write a second Update.
// The steps below consume them in that order (no judge model is configured, and nothing queues a digest).
let t: TestHost, dom: JSDOM, bridge: WebBridge, sessionId: string, artifactId: string;
let tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "Event"] as const;
const long = { timeout: 15_000 };

async function command<T>(type: string, payload: unknown): Promise<T> {
  const result = await bridge.command(type, payload);
  if (!result.ok) throw new Error(result.error.message);
  return result.result as T;
}
const query = <T,>(name: string, args: unknown) => bridge.query<T>(name, args);

beforeAll(async () => {
  t = await startTestHost();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  // These tests cover threads in the margin beside the text; threads under each block have their own tests.
  localStorage.setItem("vc-comments", "beside");
  tl = await import("@testing-library/react");
  // These tests drive a real engine beside eighty other test files: give a slow moment five seconds, not one.
  tl.configure({ asyncUtilTimeout: 5000 });
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
      content: "# Field notes\n\nMoss on basalt near the lake.\n\nA second paragraph.",
    })
  ).artifactId;
  sessionId = (
    await command<{ sessionId: string }>("vc.StartSession", { title: "Tundra walk", replyTrigger: "realtime" })
  ).sessionId;
  await command("vc.AttachArtifact", { sessionId, artifactId, role: "primary" });
  await command("sys.SetSettings", {
    patch: {
      models: { default: model, planner: model, writer: model },
      sessions: { [sessionId]: { realtimeDebounceSeconds: 1, updateIdleMinutes: 60 } },
    },
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
  await tl.waitFor(() => expect(view.container.querySelector(".vc-doc h1")).not.toBeNull());
  await tl.screen.findByRole("button", { name: "Comment on the whole session" }, { timeout: 5000 });
  return view;
}
const card = (container: HTMLElement, text: string) =>
  tl.waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>(".vc-margin .vc-thread")].find((c) =>
      c.textContent?.includes(text),
    );
    if (!found) throw new Error("no card with " + text);
    return found;
  }, long);
const elements = () => query<Array<{ elementId: string; type: string }>>("vc.Elements", { artifactId });

it("agrees to an agent option, runs an Update, and shows exactly what changed", async () => {
  const [heading] = await elements();
  await command("vc.Comment", {
    sessionId,
    anchor: { artifactId, elementId: heading!.elementId, seenVersion: 1 },
    body: "The title feels flat. Click Agree if you like.",
  });
  const { container } = await openSession();
  const thread = await card(container, "Covibe: two ways to make the title carry the idea.");
  // The agent's words are text, never a button; the option buttons say only "Agree".
  expect(tl.within(thread).getByText("Covibe, in one page")).toBeTruthy();
  tl.fireEvent.click(tl.within(thread).getByRole("button", { name: "Agree with option: Name the idea" }));
  await tl.waitFor(async () => {
    const [agreement] = await query<Agreement[]>("vc.DecisionRecord", { artifactId });
    expect(agreement).toMatchObject({ kind: "option", optionLabel: "Name the idea", state: "agreed" });
  });
  await tl.waitFor(() => expect(thread.textContent).toContain("Agreed — waiting for the next Update"));
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Update now" }));
  await tl.waitFor(() => expect(container.querySelector(".vc-strip")?.textContent).toContain("Version 2"), long);
  await tl.waitFor(() =>
    expect(container.querySelector(".vc-doc h1")?.textContent).toBe("Covibe: shaping one piece of work together"),
  );
  tl.fireEvent.click(
    tl.within(container.querySelector(".vc-strip") as HTMLElement).getByRole("button", { name: "Show changes" }),
  );
  await tl.waitFor(() => expect(container.querySelector(".vc-changes .vc-doc")).not.toBeNull());
  const changed = [...container.querySelectorAll(".vc-changes .vc-changed")].map((n) =>
    n.querySelector("[data-element-id]")?.getAttribute("data-element-id"),
  );
  expect(changed).toEqual([heading!.elementId]);
  expect(container.querySelector(".vc-results li")?.textContent).toContain("Name the idea");
});

it("declines with a reason, and switches the agent to Manual", async () => {
  const { container } = await openSession();
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Agent" }));
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Manual" }));
  await tl.waitFor(async () => {
    const sessions = await query<Array<{ sessionId: string; replyTrigger: string }>>("vc.Sessions", {});
    expect(sessions.find((s) => s.sessionId === sessionId)?.replyTrigger).toBe("manual");
  });
  await command("vc.Comment", { sessionId, body: "Add a map." });
  const thread = await card(container, "Add a map.");
  tl.fireEvent.click(tl.within(thread).getByRole("button", { name: "Decline" }));
  tl.fireEvent.change(tl.within(thread).getByLabelText("Why not? (optional)"), { target: { value: "No room." } });
  // A second click lands before the first answer is back: only one Decline may go out.
  const send = tl.within(thread.querySelector("form") as HTMLElement).getByRole("button", { name: "Decline" });
  tl.fireEvent.click(send);
  tl.fireEvent.click(send);
  await tl.waitFor(async () => {
    const items = await query<Array<{ body: string; state: string; declineReason?: string }>>("vc.FeedbackItems", {
      sessionId,
    });
    expect(items.find((c) => c.body === "Add a map.")).toMatchObject({ state: "declined", declineReason: "No room." });
  });
  // The screen follows: a declined thread is finished with, so it leaves the open threads, and nothing went wrong.
  const shown = () => [...container.querySelectorAll(".vc-thread")].map((node) => node.textContent ?? "");
  await tl.waitFor(() => expect(shown().some((text) => text.includes("Add a map."))).toBe(false), long);
  expect(tl.screen.queryByText(/VibeCab cannot do this now/)).toBeNull();
});

it("surfaces a conflict and resolves it with Choose this one", async () => {
  const paragraph = (await elements()).find((e) => e.type === "paragraph")!,
    anchor = { artifactId, elementId: paragraph.elementId, seenVersion: 2 };
  const a = await command<{ commentId: string }>("vc.Comment", { sessionId, anchor, body: "One sentence." });
  const b = await command<{ commentId: string }>("vc.Comment", { sessionId, anchor, body: "Add an example." });
  await command("vc.Agree", { commentId: a.commentId, kind: "as_written" });
  await command("vc.Agree", { commentId: b.commentId, kind: "as_written" });
  const { container } = await openSession();
  await tl.waitFor(() =>
    expect(container.querySelector(".vc-strip")?.textContent).toContain("Two agreed changes conflict"),
  );
  expect((await card(container, "One sentence.")).textContent).toContain("Conflicts with another agreed change");
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Choose" }));
  const [keep] = await tl.screen.findAllByRole("button", { name: "Choose this one" });
  tl.fireEvent.click(keep!);
  await tl.waitFor(async () => {
    const open = (await query<FeedbackConflict[]>("vc.Conflicts", { sessionId, artifactId })).filter(
      (c) => c.state === "open",
    );
    expect(open).toHaveLength(0);
  }, long);
  await tl.waitFor(() => expect(container.querySelector(".vc-strip")?.textContent).toContain("1 agreed change"));
});

it("holds an Update for plan review until Approve plan", async () => {
  const { container } = await openSession();
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Session actions" }));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Review each plan before writing" }));
  await tl.waitFor(async () => {
    const settings = await query<{ sessions?: Record<string, { planReview?: boolean }> }>("sys.Settings", {});
    expect(settings.sessions?.[sessionId]?.planReview).toBe(true);
  });
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Update now" }));
  await tl.waitFor(
    () => expect(container.querySelector(".vc-strip")?.textContent).toContain("The plan is ready for you"),
    long,
  );
  const { updates } = await query<{ updates: Update[] }>("vc.Updates", { artifactId });
  expect(updates.at(-1)?.status).toBe("awaiting_plan_review");
  expect(container.querySelector(".vc-plan")?.textContent).toContain("One sentence.");
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Approve plan" }));
  await tl.waitFor(() => expect(container.querySelector(".vc-strip")?.textContent).toContain("Version 3"), long);
});

it("asks the agent on request in Manual mode", async () => {
  await openSession();
  const before = (await query<unknown[]>("vc.AgentTurns", { sessionId })).length;
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Ask agent" }));
  await tl.waitFor(async () =>
    expect((await query<unknown[]>("vc.AgentTurns", { sessionId })).length).toBe(before + 1),
  );
});

it("shows a changed block's change history: each Update and what asked for it", async () => {
  const { container } = await openSession();
  const heading = container.querySelector<HTMLElement>(".vc-doc > h1")!;
  tl.fireEvent.mouseMove(heading);
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Change history" }));
  const dialog = await tl.screen.findByRole("dialog", { name: "Change history" });
  await tl.waitFor(() => expect(dialog.textContent).toContain("You agreed to the agent's option “Name the idea”"));
  expect(dialog.textContent).toContain("Version 2");
  // What was asked comes from the session's threads, which may arrive a moment after the dialog opens.
  await tl.waitFor(() => expect(dialog.textContent).toContain("“The title feels flat."));
  // A block no Update has touched offers no history.
  tl.fireEvent.click(tl.within(dialog).getByRole("button", { name: "Close" }));
  const untouched = [...container.querySelectorAll<HTMLElement>(".vc-doc > p")].at(-1)!;
  tl.fireEvent.mouseMove(untouched);
  await tl.screen.findByRole("button", { name: "Comment on this block" });
  expect(tl.screen.queryByRole("button", { name: "Change history" })).toBeNull();
});

it("shows what the agent cost and did in Settings → Spending → Usage", async () => {
  tl.cleanup();
  window.location.hash = "/settings/spending";
  const { App } = await import("../src/App.js");
  tl.render(<App bridge={bridge} />);
  const usage = await tl.screen.findByRole("region", { name: "Usage" });
  // Replies and Updates ran earlier in this file on the default model: "Main agent" until it has a name.
  await tl.waitFor(() =>
    expect(tl.within(usage).getByRole("table", { name: "By agent" }).textContent).toContain("Main agent"),
  );
  // Each table has its own query and shows when its own numbers arrive, so wait for this one too.
  await tl.waitFor(() => {
    const purposes = tl.within(usage).getByRole("table", { name: "By purpose" }).textContent ?? "";
    expect(purposes).toContain("Replies");
    expect(purposes).toMatch(/Updates \((writing|planning)\)/);
  });
  // Session titles arrive with the sessions list, a moment after the numbers.
  await tl.waitFor(() =>
    expect(tl.within(usage).getByRole("table", { name: "Costliest sessions" }).textContent).toContain("Tundra walk"),
  );
  let calls = 0;
  await tl.waitFor(() => {
    calls = Number(tl.within(usage).getByText("Calls", { selector: "dt" }).nextElementSibling?.textContent);
    expect(calls).toBeGreaterThan(1);
  });
  // Today only, then 30 days: the period changes what is counted, never by less than today.
  tl.fireEvent.click(tl.within(usage).getByRole("button", { name: "30 days" }));
  await tl.waitFor(() =>
    expect(
      Number(tl.within(usage).getByText("Calls", { selector: "dt" }).nextElementSibling?.textContent),
    ).toBeGreaterThanOrEqual(calls),
  );
});
