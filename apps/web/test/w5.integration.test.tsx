import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webBridge } from "../src/bridge/webBridge.js";
import type { WebBridge } from "../src/bridge/webBridge.js";
import { runExport } from "../src/session/ExportDialog.js";
import { startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

let t: TestHost, dom: JSDOM, bridge: WebBridge, sessionId: string, artifactId: string;
let tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "Event"] as const;

async function command<T>(type: string, payload: unknown): Promise<T> {
  const result = await bridge.command(type, payload);
  if (!result.ok) throw new Error(`${type}: ${result.error.message}`);
  return result.result as T;
}
const query = <T,>(name: string, args: unknown) => bridge.query<T>(name, args);

beforeAll(async () => {
  t = await startTestHost();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
  bridge = webBridge({ base: t.host.url, fetch: t.fetch, retryMs: 50 });
  artifactId = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Field notes",
      format: "markdown",
      content: "# Field notes\n\nMoss on basalt.",
    })
  ).artifactId;
  sessionId = (
    await command<{ sessionId: string }>("vc.StartSession", { title: "Tundra walk", replyTrigger: "manual" })
  ).sessionId;
  await command("vc.AttachArtifact", { sessionId, artifactId, role: "primary" });
  // Version 2: appended text.
  await command("vc.ImportContent", { artifactId, format: "markdown", content: "Sedge by the water." });
}, 60_000);
afterAll(async () => {
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

it("shows an older version read-only and restores it as the next version", async () => {
  const { container } = await open("/s/" + sessionId);
  await tl.screen.findByRole("button", { name: "Comment on the whole session" }, { timeout: 5000 });
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "History" }));
  const sheet = await tl.screen.findByRole("complementary", { name: "History" });
  await tl.waitFor(() => expect(sheet.textContent).toContain("Version 2"));
  expect(sheet.textContent).toContain("Added from a file");
  tl.fireEvent.click(tl.within(sheet).getByRole("button", { name: /Version 1/ }));
  await tl.waitFor(() => expect(container.querySelector(".vc-strip")?.textContent).toContain("Viewing version 1"));
  await tl.waitFor(() => expect(container.querySelector(".vc-doc")?.textContent).not.toContain("Sedge by the water."));
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Restore this version" }));
  expect(container.querySelector(".vc-strip")?.textContent).toContain(
    "Creates version 3 with the content of version 1. Nothing is lost.",
  );
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Restore" }));
  await tl.waitFor(async () => {
    const versions = await query<Array<{ version: number; source: { restoreOf?: number } }>>("vc.Versions", {
      artifactId,
    });
    expect(versions.find((v) => v.version === 3)?.source.restoreOf).toBe(1);
  });
  await tl.waitFor(() => expect(sheet.textContent).toContain("Restored from version 1"));
});

it("keeps a Snapshot's versions while the Draft moves on, labels it, and exports its bytes", async () => {
  await open("/s/" + sessionId);
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Save a snapshot" }, { timeout: 5000 }));
  tl.fireEvent.change(await tl.screen.findByLabelText("Label (optional)"), { target: { value: "Sent to editor" } });
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Save" }));
  let outputSetId = "";
  await tl.waitFor(async () => {
    const [snapshot] = await query<Array<{ outputSetId: string; label?: string; members: Array<{ version: number }> }>>(
      "vc.OutputSets",
      { sessionId },
    );
    expect(snapshot).toMatchObject({ label: "Sent to editor", members: [{ version: 3 }] });
    outputSetId = snapshot!.outputSetId;
  });
  await command("vc.ImportContent", { artifactId, format: "markdown", content: "A later line." });
  const [frozen] = await query<Array<{ members: Array<{ version: number }> }>>("vc.OutputSets", { sessionId });
  expect(frozen?.members[0]?.version).toBe(3);
  await command("vc.Label", { target: { outputSetId }, label: "v1 final" });
  expect(await query("vc.Labels", { outputSetId })).toMatchObject([{ label: "v1 final" }]);
  const bytes = await runExport(bridge, { outputSetId }, "markdown", { threads: false, decisionRecord: false });
  const [record] = await query<Array<{ blobHash: string; status: string }>>("vc.Exports", {});
  expect(record?.status).toBe("completed");
  expect([...bytes]).toEqual([...(await bridge.getBlob(record!.blobHash))]);
  expect(new TextDecoder().decode(bytes)).toContain("Moss on basalt.");
});

it("restores from Trash, and deletes for good after showing what goes", async () => {
  const doomed = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Old list",
      format: "markdown",
      content: "# Old list",
    })
  ).artifactId;
  const spare = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Spare",
      format: "markdown",
      content: "# Spare",
    })
  ).artifactId;
  await command("vc.Trash", { target: { kind: "artifact", id: doomed } });
  await command("vc.Trash", { target: { kind: "artifact", id: spare } });
  const { container } = await open("/trash");
  await tl.waitFor(() => expect(container.textContent).toContain("Old list"));
  const spareRow = [...container.querySelectorAll<HTMLElement>(".vc-row")].find((r) =>
    r.textContent?.includes("Spare"),
  )!;
  tl.fireEvent.click(tl.within(spareRow).getByRole("button", { name: "Restore" }));
  await tl.waitFor(async () =>
    expect((await query<Array<{ artifactId: string }>>("vc.Artifacts", {})).map((a) => a.artifactId)).toContain(spare),
  );
  const row = [...container.querySelectorAll<HTMLElement>(".vc-row")].find((r) => r.textContent?.includes("Old list"))!;
  tl.fireEvent.click(tl.within(row).getByRole("button", { name: "Delete for good" }));
  const preview = await query<{ revisionHashes: string[] }>("vc.PurgePreview", {
    target: { kind: "artifact", id: doomed },
  });
  await tl.screen.findByText(
    `This removes ${preview.revisionHashes.length} piece of text history. It cannot be undone.`,
  );
  tl.fireEvent.change(tl.screen.getByLabelText("Type the title to confirm"), { target: { value: "Old list" } });
  const dialog = container.ownerDocument.querySelector("dialog.vc-dialog") as HTMLElement;
  tl.fireEvent.click(tl.within(dialog).getByRole("button", { name: "Delete for good" }));
  await tl.waitFor(
    async () => {
      const all = await query<Array<{ artifactId: string }>>("vc.Artifacts", { includeTrashed: true });
      expect(all.map((a) => a.artifactId)).not.toContain(doomed);
    },
    { timeout: 10_000 },
  );
});

it("a restored Draft in no session shows in Drafts and opens in a new session", async () => {
  const loose = (
    await command<{ artifactId: string }>("vc.ImportContent", {
      title: "Loose page",
      format: "markdown",
      content: "# Loose",
    })
  ).artifactId;
  await command("vc.Trash", { target: { kind: "artifact", id: loose } });
  const { container } = await open("/trash");
  await tl.waitFor(() => expect(container.textContent).toContain("Loose page"));
  const row = [...container.querySelectorAll<HTMLElement>(".vc-row")].find((r) =>
    r.textContent?.includes("Loose page"),
  )!;
  tl.fireEvent.click(tl.within(row).getByRole("button", { name: "Restore" }));
  // The toast says where it went back to.
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Show" }));
  await tl.waitFor(() => expect(window.location.hash).toBe("#/drafts"));
  const draftRow = await tl.waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>(".vc-row")].find((r) =>
      r.textContent?.includes("Loose page"),
    );
    if (!found) throw new Error("not listed");
    return found;
  });
  expect(draftRow.textContent).toContain("opens in a new one");
  tl.fireEvent.click(tl.within(draftRow).getByRole("button", { name: "Loose page" }));
  await tl.waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/s/session_\\w+/d/${loose}$`)));
});

it("captures Ideas, starts a session from one, and gathers it into a Project", async () => {
  const { container } = await open("/ideas");
  const field = await tl.screen.findByLabelText("New idea");
  tl.fireEvent.change(field, { target: { value: "Night mode for writers" } });
  tl.fireEvent.submit(field.closest("form")!);
  await tl.waitFor(() => expect(container.textContent).toContain("Night mode for writers"));
  const projectId = (await command<{ projectId: string }>("vc.CreateProject", { title: "Writers" })).projectId;
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Actions for idea" }));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Add to a project" }));
  const dialog = container.ownerDocument.querySelector("dialog.vc-dialog") as HTMLElement;
  await tl.waitFor(() => expect(dialog.textContent).toContain("Writers"));
  tl.fireEvent.click(tl.within(dialog).getByRole("button", { name: "Add" }));
  await tl.waitFor(async () => {
    const [project] = await query<Array<{ projectId: string; ideaIds?: string[] }>>("vc.Projects", {});
    expect(project).toMatchObject({ projectId, ideaIds: [expect.any(String)] });
  });
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Actions for idea" }));
  tl.fireEvent.click(await tl.screen.findByRole("menuitem", { name: "Start a session" }));
  await tl.waitFor(() => expect(window.location.hash).toMatch(/^#\/s\/session_/));
  const sessions = await query<Array<{ title: string; ideaIds?: string[] }>>("vc.Sessions", {});
  expect(sessions.find((s) => s.title === "Night mode for writers")?.ideaIds).toHaveLength(1);
  const view = await open("/p/" + projectId);
  await tl.waitFor(() => expect(view.container.textContent).toContain("Night mode for writers"));
});
