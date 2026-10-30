import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { status, start } from "../../../host/src/index.js";

test("first run creates a draft, keeps secrets out of the renderer and stops the host on quit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-app-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const script = join(workspace, "fake-provider.json");
    await writeFile(
      script,
      JSON.stringify({
        defaultSequence: [
          [
            { type: "text_delta", text: "Test reply." },
            { type: "done", finishReason: "stop" },
          ],
        ],
      }),
    );
    app = await electron.launch({
      args: [resolve("apps/macos")],
      env: {
        ...process.env,
        VIBECAB_DEV: "1",
        VIBECAB_WORKSPACE_DIR: workspace,
        VIBECAB_NODE: process.execPath,
        VIBECAB_FAKE_PROVIDER: script,
      },
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("button", { name: "Blank Document" }).click();
    await expect(page.getByText("Untitled")).toBeVisible();
    const exposure = await page.evaluate(() => ({
      requireType: typeof Reflect.get(window, "require"),
      processType: typeof Reflect.get(window, "process"),
      token: Reflect.get(window.vibecab, "token"),
    }));
    expect(exposure).toEqual({ requireType: "undefined", processType: "undefined", token: undefined });
    const beforeNavigation = page.url();
    await page.evaluate(() => {
      window.location.href = "https://example.com";
    });
    await expect.poll(() => page.url()).toBe(beforeNavigation);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    app = undefined;
    await expect.poll(async () => (await status(workspace)).running).toBe(false);
  } finally {
    await app?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reuses a host started outside the app and recovers after it is killed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-app-host-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const script = join(workspace, "fake-provider.json");
    await writeFile(
      script,
      JSON.stringify({
        defaultSequence: [
          [
            { type: "text_delta", text: "Test reply." },
            { type: "done", finishReason: "stop" },
          ],
        ],
      }),
    );
    const existing = await start(workspace, { nodePath: process.execPath, fakeProvider: script });
    if (!existing.running) throw Error("Host did not start");
    app = await electron.launch({
      args: [resolve("apps/macos")],
      env: { ...process.env, VIBECAB_DEV: "1", VIBECAB_WORKSPACE_DIR: workspace, VIBECAB_NODE: process.execPath },
    });
    const page = await app.firstWindow();
    await expect(page.getByText("Connected")).toBeVisible();
    process.kill(existing.pid, "SIGKILL");
    await expect(page.getByText("Engine unreachable")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Start engine" }).click();
    await expect(page.getByText("Connected")).toBeVisible();
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    app = undefined;
  } finally {
    await app?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
