import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { status } from "../../../host/src/index.js";
import { main as cliMain } from "../../../adapters/cli/src/index.js";

// The Mac app is a shell around the web app. These checks cover what the shell adds: it starts the web host and the
// engine, shows the web app with nothing of Electron in the page, drives it from the menu, and stops the engine on
// quit. The journeys inside the web app are covered by apps/web/e2e.

const appPath = resolve(import.meta.dirname, "..");
const fakeProvider = JSON.stringify({
  defaultSequence: [
    [
      { type: "text_delta", text: "Test reply." },
      { type: "done", finishReason: "stop" },
    ],
  ],
});
type App = Awaited<ReturnType<typeof electron.launch>>;
// Each launch gets its own profile (--user-data-dir), so one run's page choices do not reach the next.
const clickMenu = (app: App, top: string, label: string) =>
  app.evaluate(
    ({ Menu }, [menu, item]) => {
      const found = Menu.getApplicationMenu()
        ?.items.find((m) => m.label === menu)
        ?.submenu?.items.find((m) => m.label === item);
      if (!found) throw new Error(`No menu item ${menu} → ${item}`);
      found.click();
    },
    [top, label] as const,
  );

test("shows the web app with nothing of Electron in the page, drives it from the menu, and stops the engine on quit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-app-e2e-"));
  let app: App | undefined;
  try {
    const script = join(workspace, "fake-provider.json");
    await writeFile(script, fakeProvider);
    app = await electron.launch({
      args: [appPath, "--user-data-dir=" + join(workspace, "profile")],
      env: {
        ...process.env,
        VIBECAB_DEV: "1",
        VIBECAB_KEYSTORE: "memory",
        VIBECAB_WORKSPACE_DIR: workspace,
        VIBECAB_NODE: process.execPath,
        VIBECAB_FAKE_PROVIDER: script,
      },
    });
    const page = await app.firstWindow();
    // The first run of the web app, served by the web host inside the app.
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByLabel("Dollars per day").fill("3");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Later" }).click();
    await expect(page.getByText("Nothing drafted yet.")).toBeVisible();
    // The page is marked as shown in the Mac window, and has no way to reach Electron or Node.
    expect(await page.evaluate(() => document.documentElement.classList.contains("vc-mac"))).toBe(true);
    const exposure = await page.evaluate(() => ({
      requireType: typeof Reflect.get(window, "require"),
      processType: typeof Reflect.get(window, "process"),
      bridge: typeof Reflect.get(window, "vibecab"),
      electron: typeof Reflect.get(window, "electron"),
    }));
    expect(exposure).toEqual({
      requireType: "undefined",
      processType: "undefined",
      bridge: "undefined",
      electron: "undefined",
    });
    // The menu drives the page: a new draft, then Settings.
    await clickMenu(app, "File", "New Draft…");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await clickMenu(app, "VibeCab", "Settings…");
    await expect.poll(() => new URL(page.url()).hash).toBe("#/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // What only the Mac app can do is in its menu.
    const own = await app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items[0]?.submenu?.items ?? [])
        .filter((m) => m.type === "checkbox")
        .map((m) => m.label),
    );
    expect(own).toEqual(["Open at Login", "Notifications"]);
    // The window stays on the app. (Last: a refused navigation leaves the page waiting.)
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

test("reuses an engine started outside the app and starts it again after it is killed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-app-host-e2e-"));
  let app: App | undefined;
  const previousDev = process.env.VIBECAB_DEV,
    previousFakeProvider = process.env.VIBECAB_FAKE_PROVIDER,
    previousKeyStore = process.env.VIBECAB_KEYSTORE;
  try {
    const script = join(workspace, "fake-provider.json");
    await writeFile(script, fakeProvider);
    process.env.VIBECAB_DEV = "1";
    process.env.VIBECAB_KEYSTORE = "memory";
    process.env.VIBECAB_FAKE_PROVIDER = script;
    const existing = await cliMain(["start", "--workspace", workspace], {
      writeOut: () => undefined,
      writeError: (message) => {
        throw new Error(message);
      },
      readSecret: async () => "unused",
      writeBytes: () => undefined,
    });
    expect(existing).toBe(0);
    const host = await status(workspace);
    if (!host.running) throw Error("CLI did not start the host");
    app = await electron.launch({
      args: [appPath, "--user-data-dir=" + join(workspace, "profile")],
      env: {
        ...process.env,
        VIBECAB_DEV: "1",
        VIBECAB_KEYSTORE: "memory",
        VIBECAB_WORKSPACE_DIR: workspace,
        VIBECAB_NODE: process.execPath,
      },
    });
    const page = await app.firstWindow();
    await expect(page.getByRole("link", { name: "Home", exact: true }).first()).toBeVisible();
    // The app used the engine that was already running.
    const reused = await status(workspace);
    expect(reused.running && reused.pid).toBe(host.pid);
    process.kill(host.pid, "SIGKILL");
    // The page checks the engine when the window gets focus, and every few seconds.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("The engine is stopped.")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Start engine" }).click();
    await expect(page.getByText("The engine is stopped.")).toBeHidden({ timeout: 30_000 });
    await expect.poll(async () => (await status(workspace)).running, { timeout: 30_000 }).toBe(true);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    app = undefined;
  } finally {
    await app?.close();
    if (previousDev === undefined) delete process.env.VIBECAB_DEV;
    else process.env.VIBECAB_DEV = previousDev;
    if (previousFakeProvider === undefined) delete process.env.VIBECAB_FAKE_PROVIDER;
    else process.env.VIBECAB_FAKE_PROVIDER = previousFakeProvider;
    if (previousKeyStore === undefined) delete process.env.VIBECAB_KEYSTORE;
    else process.env.VIBECAB_KEYSTORE = previousKeyStore;
    await rm(workspace, { recursive: true, force: true });
  }
});
