import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import {
  Contract,
  type Json,
  type Subscription,
  type SysCreateAccessTokenOperation,
} from "../../../contract/src/index.js";
import { inProcess } from "../../../adapters/in-process/src/index.js";
import { httpClient, startHttp } from "../../../adapters/http/src/index.js";
import { fixture } from "../../../engine/test/helpers.js";
import type { ContractBridge } from "../src/api.js";
import { App } from "../src/view/App.js";

let cleanupRenderer: () => void = () => undefined,
  dom: JSDOM | undefined;
afterEach(() => {
  cleanupRenderer();
  dom?.window.close();
  dom = undefined;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "navigator");
});

it("renders Drafts and Sessions from the host using the test HTTP ContractBridge", async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    const tokenResult = await inProcess(f.rawEngine).command({
      commandId: "home-integration-token",
      type: "sys.CreateAccessToken",
      payload: { name: "Home integration", channel: "http", scope: "admin" },
    });
    if (!tokenResult.ok) throw new Error(tokenResult.error.message);
    const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      tokenResult.result,
      "#/properties/result",
    ).token;
    server = await startHttp(f.rawEngine, { transport: "http" });
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
    cleanupRenderer = cleanup;
    const contract = new Contract(),
      client = httpClient(server.url, token),
      bridge: ContractBridge = {
        command: (type, payload, commandId = crypto.randomUUID()) =>
          client.command({ type, payload: contract.read<Json>("json", payload), commandId }),
        async query<T = unknown>(name: string, args: unknown): Promise<T> {
          const result = await client.query({ name, args: contract.read<Json>("json", args) });
          return contract.read<T>("json", result);
        },
        subscribe: (afterSeq, filter, onEvent) => {
          const controller = new AbortController();
          void (async () => {
            try {
              const subscription = contract.read<Subscription>("subscription", { afterSeq, filter });
              for await (const event of client.subscribe(subscription, undefined, controller.signal)) onEvent(event);
            } catch {
              // The test bridge has no recovery UI; aborting the stream is expected during cleanup.
            }
          })();
          return () => controller.abort();
        },
        putBlob: (bytes, mediaType) => client.putBlob(bytes, mediaType),
        getBlob: async () => new Uint8Array(),
        blobUrl: (hash) => `vc-blob://${hash}`,
        app: {
          state: async () => "Connected",
          startEngine: async () => "Connected",
          saveProvider: async () => undefined,
          openMarkdown: async () => undefined,
          openExternal: async () => undefined,
          setTheme: async () => undefined,
          saveFiles: async () => undefined,
          copyText: async () => undefined,
          reveal: async () => undefined,
          workspacePath: async () => "/workspace",
          restoreBackup: async () => undefined,
          mcpRelayPath: async () => "/vibecab-mcp",
          openMcpConfig: async () => undefined,
          nodeVersion: async () => "v26",
          version: async () => "test",
          onNewDraft: () => () => undefined,
          onImport: () => () => undefined,
          onTheme: () => () => undefined,
          onConnectionLost: () => () => undefined,
          onNavigate: () => () => undefined,
        },
      };
    const createdArtifact = await inProcess(f.rawEngine).command({
      commandId: "home-create-artifact",
      type: "vc.CreateArtifact",
      payload: { title: "Host draft", mediaKind: "doc" },
    });
    if (!createdArtifact.ok) throw new Error(createdArtifact.error.message);
    const artifact = contract.read<{ artifactId: string }>(
      "operations/vc.CreateArtifact",
      createdArtifact.result,
      "#/properties/result",
    );
    const startedSession = await inProcess(f.rawEngine).command({
      commandId: "home-start-session",
      type: "vc.StartSession",
      payload: { title: "Host session", replyTrigger: "manual" },
    });
    if (!startedSession.ok) throw new Error(startedSession.error.message);
    const session = contract.read<{ sessionId: string }>(
      "operations/vc.StartSession",
      startedSession.result,
      "#/properties/result",
    );
    const attached = await inProcess(f.rawEngine).command({
      commandId: "home-attach-artifact",
      type: "vc.AttachArtifact",
      payload: { sessionId: session.sessionId, artifactId: artifact.artifactId, role: "primary" },
    });
    if (!attached.ok) throw new Error(attached.error.message);
    window.vibecab = bridge;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("Host draft")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Host session/ })).toBeTruthy();
  } finally {
    await server?.close();
    await f.close();
  }
});
