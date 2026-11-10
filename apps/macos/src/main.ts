import { app, dialog } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { status, stop } from "../../../host/src/control.js";
import { httpClient } from "../../../adapters/http/src/index.js";
import { startWebHost } from "../../web/server/web-host.js";
import type { WebHost } from "../../web/server/web-host.js";
import { workspacePath } from "./paths.js";
import { switchWorkspaceFromBackup } from "./restore-workspace.js";
import { createTrayManager } from "./tray.js";
import { installApplicationMenu } from "./app-menu.js";
import { assertNode26, engineNodePath, hostEntryPath, mcpRelayPath } from "./runtime.js";
import { readAppToken } from "./app-token.js";
import { createWindowManager } from "./window-manager.js";
import { eventScript, navigateScript } from "./shell-page.js";
import { configureSmokeArguments, installSmokeHooks, markSmokeReady } from "./smoke-lifecycle.js";

// The Mac app is a window, a menu and a menu-bar item around the web app: it starts the web host inside this
// process (which starts and watches the engine) and shows it. The page gets no preload and no IPC.

configureSmokeArguments(process.argv, process.env);

const workspace = resolve(workspacePath());
/** Fixed, so the window keeps its per-browser choices (theme, sidebar) between launches; any free port if taken. */
const APP_PORT = 5165;
installSmokeHooks(process.env, (code) => app.exit(code));
const developmentHostEntry = resolve(app.getAppPath(), "../../host/bin/vibecab-host.mjs");
const developmentMcpRelay = resolve(app.getAppPath(), "../../adapters/mcp-server/bin/vibecab-mcp.mjs");
const execFileAsync = promisify(execFile);
type Preferences = {
  notificationsEnabled?: boolean;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
};
const preferencesPath = () => join(app.getPath("userData"), "preferences.json");
async function preferences(): Promise<Preferences> {
  try {
    const value: unknown = JSON.parse(await readFile(preferencesPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      ...(Reflect.get(value, "notificationsEnabled") === true ? { notificationsEnabled: true } : {}),
      ...["width", "height", "x", "y"]
        .filter((key) => Number.isFinite(Reflect.get(value, key)))
        .map((key) => [key, Reflect.get(value, key)] as const)
        .reduce<Record<string, number>>((result, [key, number]) => {
          result[key] = number;
          return result;
        }, {}),
    };
  } catch {
    return {};
  }
}
async function savePreferences(patch: Partial<Preferences>): Promise<void> {
  const current = await preferences(),
    next = { ...current, ...patch };
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(preferencesPath(), JSON.stringify(next), { mode: 0o600 });
}
let windowRef: import("electron").BrowserWindow | undefined,
  client: ReturnType<typeof httpClient> | undefined,
  webHost: WebHost | undefined,
  apiUrl = "";
let resolveEngineReady!: () => void, rejectEngineReady!: (error: unknown) => void;
const engineReady = new Promise<void>((resolveReady, rejectReady) => {
  resolveEngineReady = resolveReady;
  rejectEngineReady = rejectReady;
});
void engineReady.catch(() => undefined);
let isQuitting = false;
const createWindow = createWindowManager({
  appUrl: () => {
    if (!webHost) throw Error("VibeCab is not ready");
    return webHost.url;
  },
  preferences,
  savePreferences,
  getWindow: () => windowRef,
  setWindow: (window) => {
    windowRef = window;
  },
  isQuitting: () => isQuitting,
});
let trayManager: ReturnType<typeof createTrayManager> | undefined;

function engineHost() {
  return {
    nodePath: engineNodePath(app.isPackaged, process.resourcesPath, process.env.VIBECAB_NODE),
    hostEntry: hostEntryPath(app.isPackaged, process.resourcesPath, developmentHostEntry),
  };
}

/** The web host, inside this process: the web app's pages and its way to the engine. */
async function startWeb(): Promise<WebHost> {
  const fakeProvider = process.env.VIBECAB_DEV === "1" ? process.env.VIBECAB_FAKE_PROVIDER : undefined;
  const options = {
    workspace,
    // Packaged, the built web app lies beside the engine; in development, in the build output.
    staticRoot: app.isPackaged
      ? join(process.resourcesPath, "engine", "dist", "apps", "web", "client")
      : join(import.meta.dirname, "../../web/client"),
    engineHost: engineHost(),
    version: app.getVersion(),
    mcpRelayPath: mcpRelayPath(app.isPackaged, process.resourcesPath, developmentMcpRelay),
    ...(fakeProvider ? { fakeProvider } : {}),
  };
  try {
    return await startWebHost({ ...options, port: APP_PORT });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    return startWebHost({ ...options, port: 0 });
  }
}

/** The shell's own line to the engine, for the menu-bar item and the check before quitting. */
async function connect(): Promise<void> {
  const runtime = await status(workspace);
  if (!runtime.running) throw Error("Engine stopped");
  apiUrl = runtime.httpUrl;
  client = httpClient(apiUrl, await readAppToken(workspace));
}

/** The page can restart the engine (Settings → About); then it has a new address, and the menu-bar item follows. */
async function followEngine(): Promise<void> {
  const runtime = await status(workspace);
  if (!runtime.running || runtime.httpUrl === apiUrl) return;
  trayManager?.stop();
  await connect();
  createTray();
}

async function showWindow(): Promise<void> {
  if (!windowRef) await createWindow();
  windowRef?.show();
  windowRef?.focus();
  app.dock?.show();
}

/** Says something to the page: the shell's only way in, and there is no way back. */
async function tellPage(script: string): Promise<void> {
  await showWindow();
  await windowRef?.webContents.executeJavaScript(script);
}

function createTray(): void {
  const templatePath = app.isPackaged
    ? join(process.resourcesPath, "engine", "iconTemplate.png")
    : join(import.meta.dirname, "../../../../apps/macos/build/iconTemplate.png");
  if (!client) throw Error("Engine is not connected");
  trayManager = createTrayManager({
    client,
    workspace,
    iconPath: templatePath,
    getNotificationsEnabled: async () => (await preferences()).notificationsEnabled ?? false,
    isWindowFocused: () => windowRef?.isFocused() ?? false,
    openWindow: showWindow,
    newDraft: () => void tellPage(eventScript("new-draft")),
    navigate: (path) => void tellPage(navigateScript(path)),
    stop: () => app.quit(),
  });
  trayManager.create();
  trayManager.startEvents();
}

async function restoreBackup(): Promise<void> {
  const picked = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "VibeCab backup", extensions: ["tgz", "tar.gz", "gz"] }],
  });
  const archive = picked.filePaths[0];
  if (picked.canceled || !archive) return;
  const confirmation = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "VibeCab will stop, restore into a new workspace and switch to it.",
    detail: `Your current workspace will be kept in workspaces/ as default-before-restore-${new Date().toISOString().slice(0, 10)}.`,
  });
  if (confirmation.response !== 0) return;
  const { nodePath, hostEntry } = engineHost();
  try {
    await switchWorkspaceFromBackup({
      workspace,
      archive,
      stop: async () => {
        trayManager?.stop();
        client = undefined;
        apiUrl = "";
        await stop(workspace);
      },
      start: async () => {
        await webHost?.engine.start();
        await connect();
        createTray();
        windowRef?.webContents.reload();
      },
      restore: async (archivePath, destination) => {
        await execFileAsync(nodePath, [hostEntry, "restore", "--archive", archivePath, "--workspace", destination], {
          timeout: 300_000,
        });
      },
    });
  } catch (error) {
    dialog.showErrorBox("VibeCab could not restore the backup", error instanceof Error ? error.message : "");
  }
}

app.setName("VibeCab");
const lock = process.env.VIBECAB_SMOKE === "1" || app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    void engineReady.then(async () => {
      await createWindow();
      windowRef?.show();
      windowRef?.focus();
    });
  });
  app
    .whenReady()
    .then(async () => {
      assertNode26(engineHost().nodePath);
      webHost = await startWeb();
      await webHost.engine.start();
      await connect();
      resolveEngineReady();
      createTray();
      const trayTimer = setInterval(
        () =>
          void followEngine()
            .then(() => trayManager?.refresh())
            .catch(() => undefined),
        5000,
      );
      app.on("before-quit", () => clearInterval(trayTimer));
      installApplicationMenu({
        openSettings: () => void tellPage(navigateScript("/settings")),
        newDraft: () => void tellPage(eventScript("new-draft")),
        restoreBackup: () => void restoreBackup(),
        openAtLogin: app.getLoginItemSettings().openAtLogin,
        setOpenAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
        notifications: (await preferences()).notificationsEnabled ?? false,
        setNotifications: (enabled) => void savePreferences({ notificationsEnabled: enabled }),
        quit: () => app.quit(),
      });
      if (!app.getLoginItemSettings().wasOpenedAtLogin) {
        await createWindow();
        if (process.env.VIBECAB_SMOKE === "1") markSmokeReady(process.env, process.stdout);
      } else app.dock?.hide();
    })
    .catch((error: unknown) => {
      rejectEngineReady(error);
      console.error("VibeCab startup failed", error);
    });
  app.on("activate", () => {
    void engineReady.then(async () => {
      await createWindow();
      app.dock?.show();
      windowRef?.show();
      windowRef?.focus();
    });
  });
  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void (async () => {
      let busy = false;
      try {
        const updateResult: unknown = await client?.query({ name: "vc.Updates", args: {} });
        const updates =
          typeof updateResult === "object" && updateResult !== null && !Array.isArray(updateResult)
            ? Reflect.get(updateResult, "updates")
            : undefined;
        const turns: unknown = await client?.query({ name: "vc.AgentTurns", args: {} });
        busy =
          (Array.isArray(updates) &&
            updates.some((item) =>
              ["queued", "planning", "writing", "checking"].includes(String(Reflect.get(item, "status"))),
            )) ||
          (Array.isArray(turns) &&
            turns.some((item) => ["queued", "running"].includes(String(Reflect.get(item, "status")))));
      } catch {
        /* The host may already be gone. */
      }
      if (busy) {
        const choice = await dialog.showMessageBox({
          message: "Finishing work…",
          buttons: ["Wait", "Quit anyway"],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response === 1) {
          const runtime = await status(workspace);
          if (runtime.running) {
            process.kill(runtime.pid, "SIGTERM");
            for (let attempt = 0; attempt < 50; attempt++) {
              if (!(await status(workspace)).running) break;
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
            }
            const remaining = await status(workspace);
            if (remaining.running) process.kill(remaining.pid, "SIGKILL");
          }
        }
      }
      isQuitting = true;
      trayManager?.stop();
      await webHost?.close().catch(() => undefined);
      if (busy) await stop(workspace, { timeoutMs: 30_000 });
      else await stop(workspace, { timeoutMs: 35_000 });
      app.quit();
    })();
  });
}
