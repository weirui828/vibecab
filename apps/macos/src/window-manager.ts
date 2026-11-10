import { app, BrowserWindow, shell } from "electron";
import { external, insideApp, macClassScript } from "./shell-page.js";
import { recordSmokeConsoleMessage } from "./smoke-lifecycle.js";

export type WindowPreferences = { width?: number; height?: number; x?: number; y?: number };

export function createWindowManager(options: {
  /** The web host inside this app: the only thing the window shows. */
  appUrl: () => string;
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
        // No preload: the page is the web app and gets nothing from Electron.
        webPreferences: {
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
    window.webContents.on("dom-ready", () => void window.webContents.executeJavaScript(macClassScript));
    window.webContents.on("console-message", (_event, _level, message) =>
      recordSmokeConsoleMessage(process.env, message),
    );
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (external(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!insideApp(url, options.appUrl())) event.preventDefault();
    });
    await window.loadURL(options.appUrl() + "/");
    app.dock?.show();
  }

  return createWindow;
}
