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
    tl.within(container.querySelector(".vc-strip") as HTMLElement).getByRole("button", { name: "Changes" }),
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
  tl.fireEvent.click(tl.within(thread.querySelector("form") as HTMLElement).getByRole("button", { name: "Decline" }));
  await tl.waitFor(async () => {
    const items = await query<Array<{ body: string; state: string; declineReason?: string }>>("vc.FeedbackItems", {
      sessionId,
    });
    expect(items.find((c) => c.body === "Add a map.")).toMatchObject({ state: "declined", declineReason: "No room." });
  });
});

it("surfaces a conflict and resolves it with Keep this one", async () => {
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
  const [keep] = await tl.screen.findAllByRole("button", { name: "Keep this one" });
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
