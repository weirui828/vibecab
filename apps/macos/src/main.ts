import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from "electron";
import { Entry } from "@napi-rs/keyring";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Contract, fail } from "../../../contract/src/index.js";
import type { CommandEnvelope, QueryEnvelope, Subscription } from "../../../contract/src/index.js";
import { start, status, stop } from "../../../host/src/index.js";
import { httpClient } from "../../../adapters/http/src/index.js";
import { workspacePath } from "./paths.js";
import { isUnauthenticated, reconnectEvents, retryUnauthenticated } from "./bridge-runtime.js";

const contract = new Contract(),
  workspace = resolve(workspacePath()),
  appTokens = () => {
    try {
      const value: unknown = JSON.parse(new Entry("VibeCab", "app").getPassword() ?? "{}");
      return value;
    } catch {
      return {};
    }
  };
type Preferences = { theme?: "system" | "light" | "dark"; width?: number; height?: number; x?: number; y?: number };
const preferencesPath = () => join(app.getPath("userData"), "preferences.json");
async function preferences(): Promise<Preferences> {
  try {
    const value: unknown = JSON.parse(await readFile(preferencesPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const theme = Reflect.get(value, "theme");
    return {
      ...(theme === "system" || theme === "light" || theme === "dark" ? { theme } : {}),
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

function versionNode(nodePath: string): void {
  let version = "";
  try {
    version = execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    /* Report below. */
  }
  if (!/^v26\./.test(version)) throw Error("VibeCab requires Node 26. Set VIBECAB_NODE to a Node 26 executable.");
}

function keychainToken(): string {
  const value: unknown = appTokens(),
    raw = value && typeof value === "object" ? Reflect.get(value, workspace) : undefined;
  if (typeof raw !== "string") fail("unauthenticated", "VibeCab app token is missing");
  return raw;
}

function hostOptions() {
  const fakeProvider = process.env.VIBECAB_DEV === "1" ? process.env.VIBECAB_FAKE_PROVIDER : undefined;
  return { nodePath: process.env.VIBECAB_NODE ?? "node", ...(fakeProvider ? { fakeProvider } : {}) };
}

async function connect(): Promise<void> {
  const runtime = await status(workspace);
  if (!runtime.running) throw Error("Engine stopped");
  apiUrl = runtime.httpUrl;
  token = keychainToken();
  client = httpClient(apiUrl, token);
}

async function recoverAuthentication(): Promise<void> {
  await stop(workspace);
  await start(workspace, hostOptions());
  await connect();
}

function installBridge(): void {
  ipcMain.handle("vibe:command", (_event, raw: unknown) =>
    retryUnauthenticated(async () => {
      if (!client) await connect();
      const input = contract.read<CommandEnvelope>("command-envelope", raw);
      const result = await client!.command(input);
      if (result.ok)
        contract.read(
          "operations/" + input.type,
          { payload: input.payload, result: result.result },
          "#/properties/result",
        );
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
    const nodePath = process.env.VIBECAB_NODE ?? "node";
    versionNode(nodePath);
    await start(workspace, hostOptions());
    await connect();
    return "Connected";
  });
  ipcMain.handle("app:save-provider", async (_event, raw: unknown) => {
    const input = contract.read<{ baseUrl: string; model: string; apiKey: string }>("json", raw);
    new Entry("VibeCab", "provider:default").setPassword(input.apiKey);
    const engine = client;
    if (!engine) throw Error("Engine is not connected");
    const model = {
      provider: "openai-compatible",
      baseUrl: input.baseUrl,
      model: input.model,
      keyRef: "provider:default",
      capabilities: {
        tools: true,
        jsonSchemaOutput: true,
        streaming: true,
        maxContextTokens: 32768,
        reportsUsage: false,
      },
      pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    };
    const keyRef = await engine.command(
      contract.read<CommandEnvelope>("command-envelope", {
        commandId: randomUUID(),
        type: "sys.SetProviderKeyRef",
        payload: { alias: "default", keyRef: "provider:default" },
      }),
    );
    if (!keyRef.ok) fail(keyRef.error.code, keyRef.error.message, keyRef.error.details);
    const settings = await engine.command(
      contract.read<CommandEnvelope>("command-envelope", {
        commandId: randomUUID(),
        type: "sys.SetSettings",
        payload: { patch: { models: { default: model } } },
      }),
    );
    if (!settings.ok) fail(settings.error.code, settings.error.message, settings.error.details);
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
  ipcMain.handle("app:set-theme", (_event, theme: unknown) => {
    if (theme !== "system" && theme !== "light" && theme !== "dark") fail("invalid", "Invalid theme");
    nativeTheme.themeSource = theme;
    void savePreferences({ theme });
  });
  ipcMain.handle("app:version", () => app.getVersion());
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
      preload: join(import.meta.dirname, "preload.js"),
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
    const nodePath = process.env.VIBECAB_NODE ?? "node";
    versionNode(nodePath);
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
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "VibeCab",
          submenu: [
            { label: "About VibeCab", role: "about" },
            {
              label: "Settings…",
              accelerator: "CmdOrCtrl+,",
              click: () => windowRef?.webContents.send("app:navigate", "/settings"),
            },
            { type: "separator" },
            { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
          ],
        },
        {
          label: "File",
          submenu: [
            {
              label: "New draft",
              accelerator: "CmdOrCtrl+N",
              click: () => windowRef?.webContents.send("app:new-draft"),
            },
            { label: "Import Markdown…", click: () => windowRef?.webContents.send("app:import") },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
        { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
        {
          label: "Help",
          submenu: [],
        },
      ]),
    );
    await createWindow();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else windowRef?.show();
  });
  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void (async () => {
      let busy = false;
      try {
        const updates: unknown = await client?.query({ name: "vc.Updates", args: {} });
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
