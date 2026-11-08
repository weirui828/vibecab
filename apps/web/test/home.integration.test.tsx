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
  tl?.cleanup();
  dom?.window.close();
  for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node"])
    Reflect.deleteProperty(globalThis, key);
  await t?.close();
});

async function command<T>(type: string, payload: unknown): Promise<T> {
  const result = await bridge.command(type, payload);
  if (!result.ok) throw new Error(result.error.message);
  return result.result as T;
}

async function renderApp(shell: "sidebar" | "top" = "sidebar") {
  tl.cleanup();
  window.location.hash = "/";
  const { App } = await import("../src/App.js");
  return tl.render(<App bridge={bridge} shell={shell} />);
}

it("shows the empty Home with one way forward on a new workspace", async () => {
  await renderApp();
  expect(await tl.screen.findByText("Nothing drafted yet.")).toBeTruthy();
  expect(tl.screen.getAllByRole("button", { name: /New draft/ })).toHaveLength(1);
});

it("lists Sessions and Drafts from the engine, newest activity live, in both shells", async () => {
  const draft = await command<{ artifactId: string }>("vc.ImportContent", {
    title: "Field notes",
    format: "markdown",
    content: "# Field notes\n\nMoss on basalt.",
  });
  const session = await command<{ sessionId: string }>("vc.StartSession", { title: "Tundra walk" });
  await command("vc.AttachArtifact", { sessionId: session.sessionId, artifactId: draft.artifactId, role: "primary" });
  for (const shell of ["sidebar", "top"] as const) {
    await renderApp(shell);
    await tl.screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)\.|Working late\./ });
    expect(await tl.screen.findAllByText("Tundra walk")).not.toHaveLength(0);
    expect(tl.screen.getAllByText("Field notes").length).toBeGreaterThan(0);
    expect(tl.screen.getByText(/1 session · 1 Draft · nothing waiting/)).toBeTruthy();
  }
  // Live: a session started elsewhere appears without a reload.
  await command("vc.StartSession", { title: "Started from the CLI" });
  expect(await tl.screen.findByText("Started from the CLI", undefined, { timeout: 5000 })).toBeTruthy();
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
