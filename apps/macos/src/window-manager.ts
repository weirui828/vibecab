import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { recordSmokeConsoleMessage } from "./smoke-lifecycle.js";

export type WindowPreferences = { width?: number; height?: number; x?: number; y?: number };

export function createWindowManager(options: {
  preferences: () => Promise<WindowPreferences>;
  savePreferences: (patch: WindowPreferences) => Promise<void>;
  getWindow: () => BrowserWindow | undefined;
  setWindow: (window: BrowserWindow | undefined) => void;
  isQuitting: () => boolean;
}): () => Promise<void> {
  let creation: Promise<void> | undefined;
  async function createWindow(): Promise<void> {
    const existing = options.getWindow();
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      app.dock?.show();
      return;
    }
    if (creation) return creation;
    creation = createWindowOnce();
    try {
      await creation;
    } finally {
      creation = undefined;
    }
  }

  async function createWindowOnce(): Promise<void> {
    const saved = await options.preferences(),
      window = new BrowserWindow({
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
    options.setWindow(window);
    window.on("closed", () => {
      if (options.getWindow() === window) options.setWindow(undefined);
    });
    nativeTheme.on("updated", () => window.webContents.send("app:theme", nativeTheme.shouldUseDarkColors));
    window.on("close", (event) => {
      if (!options.isQuitting()) {
        event.preventDefault();
        window.hide();
        app.dock?.hide();
      }
    });
    const saveBounds = () => {
      if (!window.isDestroyed()) void options.savePreferences(window.getBounds());
    };
    window.on("resize", saveBounds);
    window.on("move", saveBounds);
    window.webContents.on("did-finish-load", () =>
      window.webContents.send("app:theme", nativeTheme.shouldUseDarkColors),
    );
    window.webContents.on("console-message", (_event, _level, message) =>
      recordSmokeConsoleMessage(process.env, message),
    );
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:|^mailto:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    else await window.loadFile(join(import.meta.dirname, "../../ui/index.html"));
    app.dock?.show();
  }

  return createWindow;
}
