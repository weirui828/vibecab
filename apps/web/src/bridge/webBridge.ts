import type { CommandResult, ContractError, EventEnvelope } from "../../../../contract/src/index.js";
import type { ContractBridge } from "../../../ui/src/api.js";
import type { ConnectionState } from "../../../ui/src/connection.js";

export interface AppState {
  connection: ConnectionState;
  version: string;
  workspacePath: string;
}

/** What only the web host can do; the Electron-only members of `ContractBridge.app` do not exist here. */
export interface WebAppBridge {
  state(): Promise<AppState>;
  startEngine(): Promise<ConnectionState>;
}

export type WebBridge = Omit<ContractBridge, "app"> & { app: WebAppBridge };

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
      async startEngine() {
        const res = await doFetch(base + "/app/start-engine", { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new BridgeError(await readError(res));
        return ((await res.json()) as { connection: ConnectionState }).connection;
      },
    },
  };
}
