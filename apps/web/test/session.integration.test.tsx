import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webBridge } from "../src/bridge/webBridge.js";
import type { WebBridge } from "../src/bridge/webBridge.js";
import { startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

let t: TestHost, dom: JSDOM, bridge: WebBridge, sessionId: string, notes: string, faq: string;
let tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "localStorage", "HTMLElement", "Node"] as const;

async function command<T>(type: string, payload: unknown): Promise<T> {
  const result = await bridge.command(type, payload);
  if (!result.ok) throw new Error(result.error.message);
  return result.result as T;
}

beforeAll(async () => {
  t = await startTestHost();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
  bridge = webBridge({ base: t.host.url, fetch: t.fetch, retryMs: 50 });
  notes = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Field notes",
      format: "markdown",
      content: "# Field notes\n\nMoss on basalt.\n\n- Cottongrass\n- Sedge",
    })
  ).artifactId;
  faq = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Field FAQ",
      format: "markdown",
      content: "# Field FAQ\n\nWhere is the hut?",
    })
  ).artifactId;
  sessionId = (
    await command<{ sessionId: string }>("vc.StartSession", { title: "Tundra walk", replyTrigger: "manual" })
  ).sessionId;
  await command("vc.AttachArtifact", { sessionId, artifactId: notes, role: "primary" });
  await command("vc.AttachArtifact", { sessionId, artifactId: faq, role: "reference" });
  await command("vc.Comment", { sessionId, body: "Say where the walk starts." });
}, 60_000);
afterAll(async () => {
  // Unmount and stop the event stream before the DOM goes away, or React's scheduled work finds no window.
  tl?.cleanup();
  await t?.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  dom?.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

async function open(path: string) {
  tl.cleanup();
  window.location.hash = path;
  const { App } = await import("../src/App.js");
  return tl.render(<App bridge={bridge} />);
}

it("opens a session on its first Draft and switches Drafts with the tabs", async () => {
  const { container } = await open("/s/" + sessionId);
  await tl.waitFor(() => expect(container.querySelector(".vc-doc h1")?.textContent).toBe("Field notes"));
  expect(container.querySelector(".vc-session-head h1")?.textContent).toBe("Tundra walk");
  const tabs = tl.within(container.querySelector(".vc-draft-tabs") as HTMLElement).getAllByRole("link");
  expect(tabs.map((a) => a.textContent)).toEqual(["Field notes", "Field FAQ"]);
  expect(tabs[0]?.getAttribute("aria-current")).toBe("page");
  window.location.hash = `/s/${sessionId}/d/${faq}`;
  await tl.waitFor(() => expect(container.querySelector(".vc-doc h1")?.textContent).toBe("Field FAQ"));
});

it("refreshes the Document live when a new version lands and says so", async () => {
  const { container } = await open(`/s/${sessionId}/d/${notes}`);
  await tl.waitFor(() => expect(container.querySelector(".vc-doc h1")?.textContent).toBe("Field notes"));
  await tl.waitFor(() =>
    expect(container.querySelector(".vc-session-head .vc-facts")?.textContent).toContain("version 1"),
  );
  // Importing into an existing Draft appends and commits the next version, as an Update would.
  await command("vc.ImportContent", { artifactId: notes, format: "markdown", content: "The hut is by the lake." });
  await tl.waitFor(() => expect(container.textContent).toContain("The hut is by the lake."), { timeout: 5000 });
  expect(await tl.screen.findByText("Version 2 is ready")).toBeTruthy();
  expect(container.querySelector(".vc-session-head .vc-facts")?.textContent).toContain("version 2");
});

it("shows what happened since the last visit, and Close marks the session seen", async () => {
  const { container } = await open("/s/" + sessionId);
  const strip = await tl.screen.findByRole("region", { name: "Since you were here" });
  expect(strip.textContent).toContain("1 comment");
  tl.fireEvent.click(tl.within(strip).getByRole("button", { name: "Show" }));
  expect(container.querySelector(".vc-catchup-panel")?.textContent).toContain(
    "You commented: “Say where the walk starts.”",
  );
  tl.fireEvent.click(tl.within(strip).getByRole("button", { name: "Close" }));
  expect(tl.screen.queryByRole("region", { name: "Since you were here" })).toBeNull();
  await tl.waitFor(async () => {
    const resume = await bridge.query<{ comments: unknown[] }>("vc.ResumeView", { sessionId });
    expect(resume.comments).toHaveLength(0);
  });
});

it("offers to add a Draft when the session has none", async () => {
  const empty = await command<{ sessionId: string }>("vc.StartSession", { title: "Blank walk" });
  await open("/s/" + empty.sessionId);
  expect(await tl.screen.findByText("No draft here yet.")).toBeTruthy();
  expect(tl.screen.getByRole("button", { name: /Add a draft/ })).toBeTruthy();
});
