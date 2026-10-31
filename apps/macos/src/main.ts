import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, shell } from "electron";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Contract, fail } from "../../../contract/src/index.js";
import type { CommandEnvelope, QueryEnvelope, Subscription } from "../../../contract/src/index.js";
import { start, status, stop } from "../../../host/src/control.js";
import { httpClient } from "../../../adapters/http/src/index.js";
import { workspacePath } from "./paths.js";
import type { Settings } from "../../../contract/generated/index.js";
import { isUnauthenticated, reconnectEvents, retryUnauthenticated } from "./bridge-runtime.js";
import { switchWorkspaceFromBackup } from "./restore-workspace.js";
import { createTrayManager } from "./tray.js";
import { installApplicationMenu } from "./app-menu.js";
import { assertNode26, engineNodePath, hostEntryPath, mcpRelayPath } from "./runtime.js";
import { readAppToken } from "./app-token.js";

const contract = new Contract(),
  workspace = resolve(workspacePath());
const developmentHostEntry = new URL("../../../host/bin/vibecab-host.mjs", import.meta.url).pathname;
const developmentMcpRelay = new URL("../../../adapters/mcp-server/bin/vibecab-mcp.mjs", import.meta.url).pathname;
const execFileAsync = promisify(execFile);
type Preferences = {
  theme?: "system" | "light" | "dark";
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
    const theme = Reflect.get(value, "theme");
    return {
      ...(theme === "system" || theme === "light" || theme === "dark" ? { theme } : {}),
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
let windowRef: BrowserWindow | undefined,
  client: ReturnType<typeof httpClient> | undefined,
  apiUrl = "",
  token = "";
let isQuitting = false;
const subscriptions = new Map<string, AbortController>();
let trayManager: ReturnType<typeof createTrayManager> | undefined;

function hostOptions() {
  const fakeProvider = process.env.VIBECAB_DEV === "1" ? process.env.VIBECAB_FAKE_PROVIDER : undefined;
  return {
    nodePath: engineNodePath(app.isPackaged, process.resourcesPath, process.env.VIBECAB_NODE),
    hostEntry: hostEntryPath(app.isPackaged, process.resourcesPath, developmentHostEntry),
    ...(fakeProvider ? { fakeProvider } : {}),
  };
}

async function connect(): Promise<void> {
  const runtime = await status(workspace);
  if (!runtime.running) throw Error("Engine stopped");
  apiUrl = runtime.httpUrl;
  token = await readAppToken(workspace);
  client = httpClient(apiUrl, token);
}

async function recoverAuthentication(): Promise<void> {
  trayManager?.stop();
  await stop(workspace);
  await start(workspace, hostOptions());
  await connect();
  createTray();
}

function createTray(): void {
  const templatePath = app.isPackaged
    ? join(process.resourcesPath, "engine", "iconTemplate.png")
    : join(import.meta.dirname, "../../../../apps/macos/build/iconTemplate.png");
  trayManager = createTrayManager({
    client: client!,
    workspace,
    iconPath: templatePath,
    getNotificationsEnabled: async () => (await preferences()).notificationsEnabled ?? false,
    isWindowFocused: () => windowRef?.isFocused() ?? false,
    openWindow: async () => {
      if (!windowRef) await createWindow();
      windowRef?.show();
      windowRef?.focus();
      app.dock?.show();
    },
    newDraft: () => windowRef?.webContents.send("app:new-draft"),
    navigate: (path) => windowRef?.webContents.send("app:navigate", path),
    stop: () => app.quit(),
  });
  trayManager.create();
  trayManager.startEvents();
}

function installBridge(): void {
  ipcMain.handle("vibe:command", (_event, raw: unknown) =>
    retryUnauthenticated(async () => {
      if (!client) await connect();
      const input = contract.read<CommandEnvelope>("command-envelope", raw);
      const result = await client!.command(input);
      if (result.ok) contract.read("operations/" + input.type, result.result, "#/properties/result");
      return result;
    }, recoverAuthentication),
  );
  ipcMain.handle("vibe:query", (_event, raw: unknown) =>
    retryUnauthenticated(async () => {
      if (!client) await connect();
      return client!.query(contract.read<QueryEnvelope>("query-envelope", raw));
    }, recoverAuthentication),
  );
  ipcMain.handle("vibe:put-blob", (_event, raw: unknown) =>
    retryUnauthenticated(async () => {
      if (!client) await connect();
      const input = contract.read<{ bytes: Uint8Array; mediaType: string }>("json", raw);
      return client!.putBlob(input.bytes, input.mediaType);
    }, recoverAuthentication),
  );
  ipcMain.handle("vibe:get-blob", (_event, raw: unknown) =>
    retryUnauthenticated(async () => {
      if (!client) await connect();
      if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) fail("invalid", "Invalid blob hash");
      return client!.getBlob(raw);
    }, recoverAuthentication),
  );
  ipcMain.handle("vibe:subscribe", async (event, raw: unknown) => {
    const input = contract.read<{ id: string; afterSeq: number; filter: unknown }>("json", raw),
      controller = new AbortController();
    subscriptions.set(input.id, controller);
    void (async () => {
      try {
        if (!client) await connect();
        for await (const item of reconnectEvents(
          input.afterSeq,
          controller.signal,
          (afterSeq) =>
            client!.subscribe(
              contract.read<Subscription>("subscription", { afterSeq, filter: input.filter }),
              undefined,
              controller.signal,
            ),
          async (error) => {
            event.sender.send("app:connection-lost");
            if (isUnauthenticated(error)) await recoverAuthentication();
          },
        )) {
          event.sender.send("vibe:event:" + input.id, item);
        }
      } catch {
        if (!controller.signal.aborted) event.sender.send("app:connection-lost");
      }
    })();
  });
  ipcMain.handle("vibe:unsubscribe", (_event, id: unknown) => {
    if (typeof id === "string") {
      subscriptions.get(id)?.abort();
      subscriptions.delete(id);
    }
  });
  ipcMain.handle("app:state", async () => ((await status(workspace)).running ? "Connected" : "Engine stopped"));
  ipcMain.handle("app:start-engine", async () => {
    const nodePath = engineNodePath(app.isPackaged, process.resourcesPath, process.env.VIBECAB_NODE);
    assertNode26(nodePath);
    await start(workspace, hostOptions());
    await connect();
    return "Connected";
  });
  ipcMain.handle("app:save-provider", async (_event, raw: unknown) => {
    const input = contract.read<{ baseUrl: string; model: string; apiKey: string }>("json", raw);
    const engine = client;
    if (!engine) throw Error("Engine is not connected");
    const existing = contract.read<Settings>("settings", await engine.query({ name: "sys.Settings", args: {} }));
    const existingModel = existing.models.default;
    const model = {
      ...existingModel,
      provider: "openai-compatible",
      baseUrl: input.baseUrl,
      model: input.model,
      keyRef: "provider:default",
      capabilities: existingModel?.capabilities ?? {
        tools: true,
        jsonSchemaOutput: true,
        streaming: true,
        maxContextTokens: 32768,
        reportsUsage: false,
      },
      pricing: existingModel?.pricing ?? { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    };
    const settings = await engine.command(
      contract.read<CommandEnvelope>("command-envelope", {
        commandId: randomUUID(),
        type: "sys.SetSettings",
        payload: { patch: { models: { default: model } } },
      }),
    );
    if (!settings.ok) fail(settings.error.code, settings.error.message, settings.error.details);
    const key = await engine.command(
      contract.read<CommandEnvelope>("command-envelope", {
        commandId: randomUUID(),
        type: "sys.SetProviderKey",
        payload: { alias: "default", secret: input.apiKey },
      }),
    );
    if (!key.ok) fail(key.error.code, key.error.message, key.error.details);
  });
  ipcMain.handle("app:open-markdown", async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    const path = picked.filePaths[0];
    return { name: path.split(/[\\/]/).at(-1) ?? "Document.md", content: await readFile(path, "utf8") };
  });
  ipcMain.handle("app:open-external", async (_event, url: unknown) => {
    if (typeof url === "string" && /^(https:|mailto:)/i.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle("app:set-theme", (_event, theme: unknown) => {
    if (theme !== "system" && theme !== "light" && theme !== "dark") fail("invalid", "Invalid theme");
    nativeTheme.themeSource = theme;
    void savePreferences({ theme });
  });
  ipcMain.handle("app:get-login-item", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("app:set-login-item", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") fail("invalid", "Invalid login item setting");
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("app:get-notifications-enabled", async () => (await preferences()).notificationsEnabled ?? false);
  ipcMain.handle("app:set-notifications-enabled", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") fail("invalid", "Invalid notification setting");
    await savePreferences({ notificationsEnabled: enabled });
  });
  ipcMain.handle("app:tray-status", async () => {
    await trayManager?.refresh();
    return trayManager?.snapshot();
  });
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:node-version", () =>
    execFileSync(
      engineNodePath(app.isPackaged, process.resourcesPath, process.env.VIBECAB_NODE ?? process.execPath),
      ["--version"],
      {
        encoding: "utf8",
      },
    ).trim(),
  );
  ipcMain.handle("app:workspace-path", () => workspace);
  ipcMain.handle("app:mcp-relay-path", () => mcpRelayPath(app.isPackaged, process.resourcesPath, developmentMcpRelay));
  ipcMain.handle("app:open-mcp-config", async () => {
    const configPath = join(app.getPath("appData"), "Claude", "claude_desktop_config.json");
    await shell.showItemInFolder(configPath);
  });
  ipcMain.handle("app:copy-text", (_event, raw: unknown) => {
    if (typeof raw === "string") clipboard.writeText(raw);
  });
  ipcMain.handle("app:reveal", async (_event, raw: unknown) => {
    if (typeof raw === "string") await shell.showItemInFolder(raw);
  });
  ipcMain.handle("app:save-files", async (_event, raw: unknown) => {
    if (
      !Array.isArray(raw) ||
      raw.some((item) => !item || typeof item.name !== "string" || !(item.bytes instanceof Uint8Array))
    )
      fail("invalid", "Invalid export files");
    const files = raw as Array<{ name: string; bytes: Uint8Array }>;
    const testDirectory = process.env.VIBECAB_DEV === "1" ? process.env.VIBECAB_TEST_SAVE_DIR : undefined;
    if (testDirectory) {
      await mkdir(testDirectory, { recursive: true });
      for (const file of files) await writeFile(join(testDirectory, file.name.replace(/[^\w.-]+/g, "-")), file.bytes);
      return;
    }
    if (files.length > 1) {
      const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      if (picked.canceled || !picked.filePaths[0]) return;
      for (const file of files)
        await writeFile(join(picked.filePaths[0], file.name.replace(/[^\w.-]+/g, "-")), file.bytes);
      return;
    }
    for (const file of files) {
      const picked = await dialog.showSaveDialog({ defaultPath: file.name });
      if (!picked.canceled && picked.filePath) await writeFile(picked.filePath, file.bytes);
    }
  });
  ipcMain.handle("app:restore-backup", async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "VibeCab backup", extensions: ["tgz", "tar.gz", "gz"] }],
    });
    const archive = picked.filePaths[0];
    if (picked.canceled || !archive) return;
    const confirmation = await dialog.showMessageBox(windowRef!, {
      type: "warning",
      buttons: ["Restore", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "VibeCab will stop, restore into a new workspace and switch to it.",
      detail: `Your current workspace will be kept in workspaces/ as default-before-restore-${new Date().toISOString().slice(0, 10)}.`,
    });
    if (confirmation.response !== 0) return;
    const hostEntry = hostEntryPath(app.isPackaged, process.resourcesPath, developmentHostEntry),
      nodePath = engineNodePath(app.isPackaged, process.resourcesPath, process.env.VIBECAB_NODE);
    try {
      await switchWorkspaceFromBackup({
        workspace,
        archive,
        stop: async () => {
          for (const controller of subscriptions.values()) controller.abort();
          subscriptions.clear();
          client = undefined;
          await stop(workspace);
        },
        start: async () => {
          await start(workspace, hostOptions());
          await connect();
        },
        restore: async (archivePath, destination) => {
          await execFileAsync(nodePath, [hostEntry, "restore", "--archive", archivePath, "--workspace", destination], {
            timeout: 300_000,
          });
        },
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Could not restore backup.", { cause: error });
    }
  });
}

async function createWindow(): Promise<void> {
  const saved = await preferences();
  windowRef = new BrowserWindow({
    width: saved.width ?? 1120,
    height: saved.height ?? 760,
    ...(saved.x !== undefined ? { x: saved.x } : {}),
    ...(saved.y !== undefined ? { y: saved.y } : {}),
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  nativeTheme.on("updated", () => windowRef?.webContents.send("app:theme", nativeTheme.shouldUseDarkColors));
  windowRef.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      windowRef?.hide();
      app.dock?.hide();
    }
  });
  const saveBounds = () => {
    const bounds = windowRef?.getBounds();
    if (bounds) void savePreferences(bounds);
  };
  windowRef.on("resize", saveBounds);
  windowRef.on("move", saveBounds);
  windowRef.webContents.on("did-finish-load", () =>
    windowRef?.webContents.send("app:theme", nativeTheme.shouldUseDarkColors),
  );
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:|^mailto:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  windowRef.webContents.on("will-navigate", (event, url) => {
    if (url !== windowRef?.webContents.getURL()) event.preventDefault();
  });
  if (process.env.VITE_DEV_SERVER_URL) await windowRef.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await windowRef.loadFile(join(import.meta.dirname, "../../ui/index.html"));
  app.dock?.show();
}

app.setName("VibeCab");
protocol.registerSchemesAsPrivileged([
  { scheme: "vc-blob", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (windowRef) {
      windowRef.show();
      windowRef.focus();
    }
  });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = (await preferences()).theme ?? "system";
    const nodePath = engineNodePath(app.isPackaged, process.resourcesPath, process.env.VIBECAB_NODE);
    assertNode26(nodePath);
    protocol.handle("vc-blob", async (request) => {
      const hash = new URL(request.url).hostname;
      if (!/^[a-f0-9]{64}$/.test(hash)) return new Response("Not found", { status: 404 });
      const response = await fetch(apiUrl + "/v1/blobs/" + hash, { headers: { Authorization: "Bearer " + token } });
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      });
    });
    await start(workspace, hostOptions());
    await connect();
    installBridge();
    createTray();
    const trayTimer = setInterval(() => void trayManager?.refresh(), 5000);
    app.on("before-quit", () => clearInterval(trayTimer));
    installApplicationMenu({
      openSettings: () => {
        void trayManager?.refresh();
        windowRef?.webContents.send("app:navigate", "/settings");
      },
      newDraft: () => windowRef?.webContents.send("app:new-draft"),
      importMarkdown: () => windowRef?.webContents.send("app:import"),
      quit: () => app.quit(),
    });
    if (!app.getLoginItemSettings().wasOpenedAtLogin) await createWindow();
    else app.dock?.hide();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else {
      app.dock?.show();
      windowRef?.show();
    }
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
      for (const controller of subscriptions.values()) controller.abort();
      if (busy) await stop(workspace, { timeoutMs: 30_000 });
      else await stop(workspace, { timeoutMs: 35_000 });
      app.quit();
    })();
  });
}
