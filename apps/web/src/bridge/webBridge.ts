import type { CommandResult, ContractError, EventEnvelope } from "../../../../contract/src/index.js";
import type { LiveModel } from "../../../../contract/src/provider-catalog.js";
import type { ConnectionState } from "../connection.js";

export interface AppState {
  connection: ConnectionState;
  version: string;
  workspacePath: string;
  mcpRelayPath?: string;
  /** The running engine: when it started, when its code was built, and whether it runs older code. */
  engine?: { startedAt: string; builtAt?: string; outdated: boolean } | null;
}

/** What only the web host can do, beside the contract. */
export interface WebAppBridge {
  state(): Promise<AppState>;
  startEngine(): Promise<ConnectionState>;
  /** Stops the engine and starts it again with the current code. */
  restartEngine(): Promise<ConnectionState>;
  /** A built-in provider's live model list (OpenRouter, local servers); empty with a reason when there is none. */
  providerModels(providerId: string): Promise<{ models: LiveModel[]; error?: string }>;
}

/**
 * The renderer's only way to the engine (AGENTS.md §9.1): the contract's five calls, plus what the web host adds.
 * The renderer never holds a token, opens a socket of its own, or imports engine code.
 */
export interface ContractBridge {
  command(type: string, payload: unknown, commandId?: string): Promise<CommandResult>;
  query<T = unknown>(name: string, args: unknown): Promise<T>;
  subscribe(afterSeq: number, filter: unknown, onEvent: (event: EventEnvelope) => void): () => void;
  putBlob(bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array>;
  blobUrl(hash: string): string;
}

export type WebBridge = ContractBridge & { app: WebAppBridge };

export class BridgeError extends Error {
  constructor(readonly error: ContractError) {
    super(error.message);
  }
}

type Fetch = typeof fetch;

function isContractError(value: unknown): value is ContractError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

let counter = 0;
export function newCommandId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `web-${Date.now().toString(36)}-${++counter}-${random}`;
}

async function readError(res: Response): Promise<ContractError> {
  try {
    const value: unknown = await res.json();
    if (isContractError(value)) return value;
  } catch {
    // fall through
  }
  return { code: res.status === 401 ? "unauthenticated" : "unavailable", message: res.statusText, retryable: true };
}

/** Parses an SSE byte stream into event payloads. Exported for tests. */
export function sseParser(onData: (data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) onData(data);
    }
  };
}

// ContractBridge over the web host (same origin). The token stays in the web host.
export function webBridge(options: { base?: string; fetch?: Fetch; retryMs?: number } = {}): WebBridge {
  const base = options.base ?? "",
    doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init)),
    retryMs = options.retryMs ?? 1000;
  async function post(path: string, body: unknown): Promise<Response> {
    return doFetch(base + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return {
    async command(type, payload, commandId = newCommandId()): Promise<CommandResult> {
      let res: Response;
      try {
        res = await post("/v1/commands/" + encodeURIComponent(type), { commandId, payload });
      } catch {
        return { ok: false, error: { code: "unavailable", message: "The engine is unreachable", retryable: true } };
      }
      if (!res.ok) return { ok: false, error: await readError(res) };
      return (await res.json()) as CommandResult;
    },
    async query<T>(name: string, args: unknown): Promise<T> {
      const res = await post("/v1/queries/" + encodeURIComponent(name), { args });
      if (!res.ok) throw new BridgeError(await readError(res));
      return (await res.json()) as T;
    },
    subscribe(afterSeq, filter, onEvent) {
      let last = afterSeq,
        stopped = false,
        controller: AbortController | undefined;
      const query = filter && Object.keys(filter).length ? "&filter=" + encodeURIComponent(JSON.stringify(filter)) : "";
      const deliver = (data: string) => {
        const event = JSON.parse(data) as EventEnvelope;
        // Reconnects resume after the last seq; never deliver a gap-filler twice.
        if (event.seq <= last) return;
        last = event.seq;
        onEvent(event);
      };
      async function loop() {
        while (!stopped) {
          controller = new AbortController();
          try {
            const res = await doFetch(base + "/v1/events?after=" + last + query, {
              credentials: "same-origin",
              headers: { Accept: "text/event-stream", "Last-Event-ID": String(last) },
              signal: controller.signal,
            });
            if (res.ok && res.body) {
              const reader = res.body.getReader(),
                decoder = new TextDecoder(),
                feed = sseParser(deliver);
              while (!stopped) {
                const part = await reader.read();
                if (part.done) break;
                feed(decoder.decode(part.value, { stream: true }));
              }
            }
          } catch {
            // dropped; retry below
          }
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
      }
      void loop();
      return () => {
        stopped = true;
        controller?.abort();
      };
    },
    async putBlob(bytes, mediaType) {
      const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource),
        hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const res = await doFetch(base + "/v1/blobs/" + hash, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": mediaType },
        body: bytes as BodyInit,
      });
      if (!res.ok) throw new BridgeError(await readError(res));
      return hash;
    },
    async getBlob(hash) {
      const res = await doFetch(base + "/v1/blobs/" + hash, { credentials: "same-origin" });
      if (!res.ok) throw new BridgeError(await readError(res));
      return new Uint8Array(await res.arrayBuffer());
    },
    blobUrl: (hash) => base + "/v1/blobs/" + hash,
    app: {
      async state() {
        const res = await doFetch(base + "/app/state", { credentials: "same-origin" });
        if (!res.ok) throw new BridgeError(await readError(res));
        return (await res.json()) as AppState;
      },
      async providerModels(providerId) {
        const res = await doFetch(base + "/app/provider-models?provider=" + encodeURIComponent(providerId), {
          credentials: "same-origin",
        });
        if (!res.ok) throw new BridgeError(await readError(res));
        return (await res.json()) as { models: LiveModel[]; error?: string };
      },
      async restartEngine() {
        const res = await doFetch(base + "/app/restart-engine", { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new BridgeError(await readError(res));
        return ((await res.json()) as { connection: ConnectionState }).connection;
      },
      async startEngine() {
        const res = await doFetch(base + "/app/start-engine", { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new BridgeError(await readError(res));
        return ((await res.json()) as { connection: ConnectionState }).connection;
      },
    },
  };
}
