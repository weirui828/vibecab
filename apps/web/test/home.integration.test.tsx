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
  // These tests drive a real engine beside eighty other test files: give a slow moment five seconds, not one.
  tl.configure({ asyncUtilTimeout: 5000 });
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
  await tl.screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)\./ });
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
  // A Draft comes from a file; an empty one is asked for in so many words.
  tl.fireEvent.click(tl.screen.getByRole("checkbox", { name: /Start with an empty page/ }));
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
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Add an existing draft" }));
  const dialog = await tl.screen.findByRole("dialog", { name: "Add an existing draft" });
  expect(dialog.textContent).toContain("joins “On hold”, which resumes.");
  tl.fireEvent.change(tl.within(dialog).getByRole("combobox"), { target: { value: extra } });
  tl.fireEvent.click(tl.within(dialog).getByRole("button", { name: "Add" }));
  await tl.waitFor(async () => {
    const [session] = await bridge.query<Array<{ state: string; artifactIds: string[] }>>("vc.Sessions", {
      sessionId,
    });
    expect(session?.state).toBe("active");
    expect(session?.artifactIds).toContain(extra);
  });
  expect(window.location.hash).toBe(`#/s/${sessionId}/d/${extra}`);
});

it("New Draft asks for a file in one clear place, and says what is missing", async () => {
  await renderApp();
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "New draft" }));
  const dialog = tl.within(await tl.screen.findByRole("dialog", { name: "New draft" }));
  // The file's place says what it takes and has a button of its own; nothing is chosen for the person.
  expect(dialog.getByText("Drop a file here")).toBeTruthy();
  expect(dialog.getByText("Markdown, plain text or HTML")).toBeTruthy();
  expect(dialog.getByRole("button", { name: "Choose a file" })).toBeTruthy();
  tl.fireEvent.click(dialog.getByRole("button", { name: "Create" }));
  expect((await dialog.findByRole("alert")).textContent).toBe("Choose a file, or start with an empty page.");
  // With an empty page chosen, the only thing missing is its title; the first message is gone.
  tl.fireEvent.click(dialog.getByRole("checkbox", { name: /Start with an empty page/ }));
  expect(dialog.queryByRole("alert")).toBeNull();
  tl.fireEvent.click(dialog.getByRole("button", { name: "Create" }));
  expect(await dialog.findByText("Give it a title.")).toBeTruthy();
  // A chosen file is named where it was dropped, with its kind, and gives the Draft its title.
  const file = new window.File(["<!doctype html><h1>Hi</h1>"], "Field report.html", { type: "text/html" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve("<!doctype html><h1>Hi</h1>") });
  tl.fireEvent.change(dialog.getByLabelText("File"), { target: { files: [file] } });
  expect(await dialog.findByText("Field report.html")).toBeTruthy();
  expect(dialog.getByText(/^HTML\. It is kept as it is/)).toBeTruthy();
  expect(dialog.queryByText("Give it a title.")).toBeNull();
  expect(dialog.getByLabelText("Title").getAttribute("placeholder")).toBe("Field report");
  expect((dialog.getByRole("checkbox", { name: /Start with an empty page/ }) as HTMLInputElement).checked).toBe(false);
  expect(dialog.getByRole("button", { name: "Choose another file" })).toBeTruthy();
});

it("keeps Sessions, Drafts and Ideas on Home as three tabs, each with its own address", async () => {
  await renderApp();
  const tabs = tl.within(await tl.screen.findByRole("tablist", { name: "Home" }));
  const selected = () => tabs.getAllByRole("tab").filter((tab) => tab.getAttribute("aria-selected") === "true");
  expect(selected().map((tab) => tab.textContent?.replace(/\s*\d+$/, ""))).toEqual(["Sessions"]);
  // One panel at a time: the session lines now, and no list of Drafts under them.
  const panel = () => tl.screen.getByRole("tabpanel");
  expect(panel().querySelector(".vc-line")).not.toBeNull();
  expect(panel().querySelector(".vc-list")).toBeNull();
  tl.fireEvent.click(tabs.getByRole("tab", { name: /^Drafts/ }));
  window.location.hash = "/drafts";
  await tl.waitFor(() => expect(selected().map((tab) => tab.id)).toEqual(["home-tab-drafts"]));
  expect(panel().querySelector(".vc-line")).toBeNull();
  expect(tl.within(panel()).getAllByText("Field notes").length).toBeGreaterThan(0);
  // The greeting stays the page's heading, and the bar still says this is Home.
  expect(tl.screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good /);
  expect(tl.screen.getByText("Thinking. Vibing. Building.")).toBeTruthy();
  // Arrow keys move along the tabs, as tabs do.
  tl.fireEvent.keyDown(tabs.getByRole("tab", { name: /^Drafts/ }), { key: "ArrowRight" });
  await tl.waitFor(() => expect(window.location.hash).toBe("#/ideas"));
  await tl.waitFor(() => expect(selected().map((tab) => tab.id)).toEqual(["home-tab-ideas"]));
  expect(await tl.within(panel()).findByRole("textbox", { name: "New idea" })).toBeTruthy();
});

it("shows a session's state, pauses and resumes it, asks before ending, and lists ended ones", async () => {
  const sessionId = (await command<{ sessionId: string }>("vc.StartSession", { title: "Field season" })).sessionId;
  tl.cleanup();
  window.location.hash = "/s/" + sessionId;
  const { App } = await import("../src/App.js");
  tl.render(<App bridge={bridge} />);
  const state = async (name: string) => tl.screen.findByRole("button", { name: new RegExp(`^${name}`) });
  const stateOf = async () => (await bridge.query<Array<{ state: string }>>("vc.Sessions", { sessionId }))[0]?.state;
  tl.fireEvent.click(await state("Active"));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Pause" }));
  await tl.waitFor(async () => expect(await stateOf()).toBe("paused"));
  tl.fireEvent.click(await state("Paused"));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Resume" }));
  await tl.waitFor(async () => expect(await stateOf()).toBe("active"));
  // Ending asks first, and offers pausing instead.
  tl.fireEvent.click(await state("Active"));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "End session…" }));
  const ask = await tl.screen.findByRole("dialog", { name: "End “Field season”?" });
  expect(tl.within(ask).getByRole("button", { name: "Pause instead" })).toBeTruthy();
  tl.fireEvent.click(tl.within(ask).getByRole("button", { name: "End session" }));
  await tl.waitFor(async () => expect(await stateOf()).toBe("ended"));
  // Ended sessions leave Home but stay one jump away, on the Sessions page.
  tl.fireEvent.click(tl.screen.getByRole("button", { name: /Jump to/ }));
  const more = await tl.screen.findByRole("link", { name: /^\d+ ended/ });
  expect(more.getAttribute("href")).toBe("#/sessions/ended");
  tl.fireEvent.click(more);
  window.location.hash = "/sessions/ended";
  const ended = await tl.screen.findByRole("region", { name: "Ended" });
  await tl.waitFor(() => expect(ended.textContent).toContain("Field season"));
  expect(tl.screen.queryByRole("region", { name: "Active" })).toBeNull();
});

it("gets around from one bar: what needs you, a jump box for everything else, and no sidebar", async () => {
  const { container } = await renderApp();
  const bar = tl.within((await tl.screen.findByRole("banner")) as HTMLElement);
  expect(container.querySelector("aside")).toBeNull();
  // The wind is silent: nothing in the bar makes sound.
  expect(bar.queryByRole("button", { name: /sound/i })).toBeNull();
  // On Home the bar says the tagline; elsewhere it says where you are, with the way back.
  expect(bar.getByText("Thinking. Vibing. Building.")).toBeTruthy();
  // The jump box finds a session by a few letters and goes there on Enter.
  await tl.screen.findByRole("link", { name: "Tundra walk" });
  tl.fireEvent.keyDown(window, { key: "k", metaKey: true });
  const box = await tl.screen.findByRole("dialog", { name: "Jump to" });
  tl.fireEvent.change(tl.within(box).getByRole("textbox", { name: "Jump to" }), { target: { value: "walk active" } });
  expect(tl.within(box).getAllByRole("link")).toHaveLength(1);
  tl.fireEvent.keyDown(box, { key: "Enter" });
  await tl.waitFor(() => expect(window.location.hash).toMatch(/^#\/s\/session_/));
  expect(tl.screen.queryByRole("dialog", { name: "Jump to" })).toBeNull();
  const here = await tl.screen.findByRole("navigation", { name: "You are here" });
  expect(here.textContent).toContain("Tundra walk");
  // Settings is a page like any other: one click from the bar, and listed in the jump box.
  expect(bar.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("#/settings");
});

it("draws each session on Home as its own line, with the reason in words", async () => {
  const { container } = await renderApp();
  const line = (await tl.screen.findByRole("link", { name: "Tundra walk" })).closest("li") as HTMLElement;
  expect(line.querySelector(".why")?.textContent).toBe("Nothing is waiting.");
  // One stop per version of its Draft, and one more, faint, for the version to come (once its Draft has loaded).
  await tl.waitFor(() => expect(line.querySelectorAll(".vc-mini-stop")).toHaveLength(2), { timeout: 5000 });
  expect(line.querySelectorAll(".ahead .vc-mini-stop")).toHaveLength(1);
  expect(line.querySelector("use")?.getAttribute("href")).toBe("#vc-gondola");
  // The cab is cut from the mark itself, once, for every line to use.
  expect(container.querySelector("#vc-gondola path.vc-cab-ink")).not.toBeNull();
});
