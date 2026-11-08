import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webBridge } from "../src/bridge/webBridge.js";
import type { WebBridge } from "../src/bridge/webBridge.js";
import { startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

let t: TestHost, dom: JSDOM, bridge: WebBridge;
let tl: typeof import("@testing-library/react");

beforeAll(async () => {
  t = await startTestHost();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node"] as const)
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
  bridge = webBridge({ base: t.host.url, fetch: t.fetch, retryMs: 50 });
}, 60_000);
afterAll(async () => {
  // Unmount and stop the event stream before the DOM goes away, or React's scheduled work finds no window.
  tl?.cleanup();
  await t?.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  dom?.window.close();
  for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node"])
    Reflect.deleteProperty(globalThis, key);
});

async function command<T>(type: string, payload: unknown): Promise<T> {
  const result = await bridge.command(type, payload);
  if (!result.ok) throw new Error(result.error.message);
  return result.result as T;
}

async function renderApp() {
  tl.cleanup();
  window.location.hash = "/";
  const { App } = await import("../src/App.js");
  return tl.render(<App bridge={bridge} />);
}

it("welcomes a new workspace without a model with the first run", async () => {
  await renderApp();
  expect(await tl.screen.findByText("Welcome to VibeCab.")).toBeTruthy();
  expect(tl.screen.getByRole("button", { name: "Get started" })).toBeTruthy();
});

it("lists Sessions and Drafts from the engine, and keeps them live", async () => {
  const draft = await command<{ artifactId: string }>("vc.ImportContent", {
    title: "Field notes",
    format: "markdown",
    content: "# Field notes\n\nMoss on basalt.",
  });
  const session = await command<{ sessionId: string }>("vc.StartSession", { title: "Tundra walk" });
  await command("vc.AttachArtifact", { sessionId: session.sessionId, artifactId: draft.artifactId, role: "primary" });
  await renderApp();
  await tl.screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)\.|Working late\./ });
  expect(await tl.screen.findAllByText("Tundra walk")).not.toHaveLength(0);
  expect(tl.screen.getAllByText("Field notes").length).toBeGreaterThan(0);
  expect(tl.screen.getByText(/1 session · 1 Draft · nothing waiting/)).toBeTruthy();
  // Live: a session started elsewhere appears without a reload.
  await command("vc.StartSession", { title: "Started from the CLI" });
  // It shows up on Home and in the sidebar.
  expect(await tl.screen.findAllByText("Started from the CLI", undefined, { timeout: 5000 })).not.toHaveLength(0);
});

it("creates a blank Draft in a new Session and opens it", async () => {
  await renderApp();
  const [button] = await tl.screen.findAllByRole("button", { name: /New draft/ });
  tl.fireEvent.click(button!);
  const title = await tl.screen.findByLabelText("Title");
  tl.fireEvent.change(title, { target: { value: "Letter to the editor" } });
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Create" }));
  await tl.waitFor(() => expect(window.location.hash).toMatch(/^#\/s\/session_/), { timeout: 5000 });
  const sessions = await bridge.query<Array<{ title: string; artifactIds: string[] }>>("vc.Sessions", {});
  expect(sessions.find((s) => s.title === "Letter to the editor")?.artifactIds).toHaveLength(1);
});

it("moves a Session to Trash and brings it back with Undo", async () => {
  await renderApp();
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Actions for Tundra walk" }));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Move to Trash" }));
  const undo = await tl.screen.findByRole("button", { name: "Undo" });
  await tl.waitFor(async () => {
    const sessions = await bridge.query<Array<{ title: string }>>("vc.Sessions", {});
    expect(sessions.map((s) => s.title)).not.toContain("Tundra walk");
  });
  tl.fireEvent.click(undo);
  await tl.waitFor(async () => {
    const sessions = await bridge.query<Array<{ title: string }>>("vc.Sessions", {});
    expect(sessions.map((s) => s.title)).toContain("Tundra walk");
  });
});

it("brings a Draft into a paused session by resuming it, and says so first", async () => {
  const draft = async (title: string) =>
    (await command<{ artifactId: string }>("vc.CreateArtifact", { title, mediaKind: "doc" })).artifactId;
  const main = await draft("Paused main"),
    extra = await draft("Bring me in");
  const sessionId = (await command<{ sessionId: string }>("vc.StartSession", { title: "On hold" })).sessionId;
  await command("vc.AttachArtifact", { sessionId, artifactId: main, role: "primary" });
  await command("vc.PauseSession", { sessionId });
  tl.cleanup();
  window.location.hash = "/s/" + sessionId;
  const { App } = await import("../src/App.js");
  tl.render(<App bridge={bridge} />);
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Session actions" }));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Bring in a draft" }));
  const dialog = await tl.screen.findByRole("dialog", { name: "Bring in a draft" });
  expect(dialog.textContent).toContain("joins “On hold”, which resumes.");
  tl.fireEvent.change(tl.within(dialog).getByRole("combobox"), { target: { value: extra } });
  tl.fireEvent.click(tl.within(dialog).getByRole("button", { name: "Bring in" }));
  await tl.waitFor(async () => {
    const [session] = await bridge.query<Array<{ state: string; artifactIds: string[] }>>("vc.Sessions", {
      sessionId,
    });
    expect(session?.state).toBe("active");
    expect(session?.artifactIds).toContain(extra);
  });
  expect(window.location.hash).toBe(`#/s/${sessionId}/d/${extra}`);
});

it("clears “Give it a title.” once a file is chosen or the kind of Draft changes", async () => {
  await renderApp();
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "New draft" }));
  const dialog = await tl.screen.findByRole("dialog", { name: "New draft" });
  tl.fireEvent.click(tl.within(dialog).getByRole("button", { name: "Create" }));
  expect(await tl.within(dialog).findByText("Give it a title.")).toBeTruthy();
  tl.fireEvent.click(tl.within(dialog).getByText("Import Markdown"));
  expect(tl.within(dialog).queryByText("Give it a title.")).toBeNull();
});
