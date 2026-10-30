import { contextBridge, ipcRenderer } from "electron";
import type { EventEnvelope } from "../../../contract/src/index.js";
import type { ContractBridge } from "../../ui/src/api.js";

const bridge: ContractBridge = {
  command: (type, payload, commandId = globalThis.crypto.randomUUID()) =>
    ipcRenderer.invoke("vibe:command", { type, payload, commandId }),
  query: (name, args) => ipcRenderer.invoke("vibe:query", { name, args }),
  subscribe: (afterSeq, filter, onEvent) => {
    const id = globalThis.crypto.randomUUID(),
      listener = (_event: Electron.IpcRendererEvent, value: unknown) => onEvent(value as EventEnvelope);
    ipcRenderer.on("vibe:event:" + id, listener);
    void ipcRenderer.invoke("vibe:subscribe", { id, afterSeq, filter });
    return () => {
      ipcRenderer.removeListener("vibe:event:" + id, listener);
      void ipcRenderer.invoke("vibe:unsubscribe", id);
    };
  },
  putBlob: (bytes, mediaType) => ipcRenderer.invoke("vibe:put-blob", { bytes, mediaType }),
  getBlob: (hash) => ipcRenderer.invoke("vibe:get-blob", hash),
  blobUrl: (hash) => `vc-blob://${hash}`,
  app: {
    state: () => ipcRenderer.invoke("app:state"),
    startEngine: () => ipcRenderer.invoke("app:start-engine"),
    saveProvider: (baseUrl, model, apiKey) => ipcRenderer.invoke("app:save-provider", { baseUrl, model, apiKey }),
    openMarkdown: () => ipcRenderer.invoke("app:open-markdown"),
    openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
    setTheme: (theme) => ipcRenderer.invoke("app:set-theme", theme),
    saveFiles: (files) => ipcRenderer.invoke("app:save-files", files),
    copyText: (text) => ipcRenderer.invoke("app:copy-text", text),
    reveal: (path) => ipcRenderer.invoke("app:reveal", path),
    workspacePath: () => ipcRenderer.invoke("app:workspace-path"),
    restoreBackup: () => ipcRenderer.invoke("app:restore-backup"),
    mcpRelayPath: () => ipcRenderer.invoke("app:mcp-relay-path"),
    openMcpConfig: () => ipcRenderer.invoke("app:open-mcp-config"),
    nodeVersion: () => ipcRenderer.invoke("app:node-version"),
    version: () => ipcRenderer.invoke("app:version"),
    onNewDraft: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("app:new-draft", handler);
      return () => ipcRenderer.removeListener("app:new-draft", handler);
    },
    onImport: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("app:import", handler);
      return () => ipcRenderer.removeListener("app:import", handler);
    },
    onTheme: (listener: (dark: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, dark: boolean) => listener(dark);
      ipcRenderer.on("app:theme", handler);
      return () => ipcRenderer.removeListener("app:theme", handler);
    },
    onConnectionLost: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("app:connection-lost", handler);
      return () => ipcRenderer.removeListener("app:connection-lost", handler);
    },
    onNavigate: (listener: (path: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, path: string) => listener(path);
      ipcRenderer.on("app:navigate", handler);
      return () => ipcRenderer.removeListener("app:navigate", handler);
    },
  },
};

contextBridge.exposeInMainWorld("vibecab", bridge);
