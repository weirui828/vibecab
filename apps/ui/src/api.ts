import type { CommandResult, EventEnvelope } from "../../../contract/src/index.js";

export interface ContractBridge {
  command(type: string, payload: unknown, commandId?: string): Promise<CommandResult>;
  query<T = unknown>(name: string, args: unknown): Promise<T>;
  subscribe(afterSeq: number, filter: unknown, onEvent: (event: EventEnvelope) => void): () => void;
  putBlob(bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array>;
  blobUrl(hash: string): string;
  app: {
    state(): Promise<string>;
    startEngine(): Promise<string>;
    saveProvider(baseUrl: string, model: string, apiKey: string): Promise<void>;
    openMarkdown(): Promise<{ name: string; content: string } | undefined>;
    openExternal(url: string): Promise<void>;
    setTheme(theme: "system" | "light" | "dark"): Promise<void>;
    saveFiles(files: Array<{ name: string; bytes: Uint8Array }>): Promise<void>;
    copyText(text: string): Promise<void>;
    reveal(path: string): Promise<void>;
    workspacePath(): Promise<string>;
    restoreBackup(): Promise<void>;
    mcpRelayPath(): Promise<string>;
    openMcpConfig(): Promise<void>;
    nodeVersion(): Promise<string>;
    version(): Promise<string>;
    onNewDraft(listener: () => void): () => void;
    onImport(listener: () => void): () => void;
    onTheme(listener: (dark: boolean) => void): () => void;
    onConnectionLost(listener: () => void): () => void;
    onNavigate(listener: (path: string) => void): () => void;
  };
}

declare global {
  interface Window {
    vibecab: ContractBridge;
  }
}
