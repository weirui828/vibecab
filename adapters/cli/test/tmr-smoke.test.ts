import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { CONTRACT_VERSION, Contract, type Json } from "../../../contract/src/index.js";
import { createEngine } from "../../../engine/src/engine.js";
import type { ModelProvider } from "../../../engine/src/gateway/types.js";
import { startHttp } from "../../http/src/index.js";
import { main } from "../src/index.js";

const keyring = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    private readonly key: string;
    constructor(service: string, account: string) {
      this.key = service + ":" + account;
    }
    getPassword() {
      return keyring.get(this.key) ?? null;
    }
    setPassword(value: string) {
      keyring.set(this.key, value);
    }
  },
}));

const liveModel = {
  provider: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  keyRef: "test-only",
  capabilities: {
    tools: false,
    jsonSchemaOutput: true,
    streaming: true,
    maxContextTokens: 4096,
    reportsUsage: false,
  },
  pricing: { inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 100_000 },
};

it("smokes tmr submit, status, report, cancel, and resume through the CLI client", async () => {
  let markStarted!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve)),
    provider: ModelProvider = {
      async *call() {
        markStarted();
        await gate;
        yield { type: "output", json: { recommendation: "CLI live review" } };
        yield { type: "done", finishReason: "stop" };
      },
    },
    workspace = await mkdtemp(join(tmpdir(), "vibecab-cli-tmr-")),
    input = join(workspace, "proposal.md"),
    output: string[] = [],
    errors: string[] = [],
    io = {
      writeOut: (value: string) => output.push(value),
      writeError: (value: string) => errors.push(value),
      readSecret: async () => "unused",
      writeBytes: () => undefined,
    },
    engine = createEngine({ modelProviders: { "openai-compatible": provider } });
  let http: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    await engine.start(workspace);
    const tokenResult = await engine.command(
      engine.inProcessAuth,
      {
        contractVersion: CONTRACT_VERSION,
        requestId: "cli-test-token-result",
      },
      {
        commandId: "cli-test-token-result",
        type: "sys.CreateAccessToken",
        payload: { name: "CLI test", channel: "cli", scope: "admin" },
      },
    );
    if (!tokenResult.ok) throw Error("Could not create CLI test token");
    const token = get(tokenResult.result, "token");
    if (typeof token !== "string") throw Error("CLI test token missing");
    keyring.set("VibeCab:cli", JSON.stringify({ [workspace]: token }));
    http = await startHttp(engine, { port: 0, transport: "cli" });
    await mkdir(join(workspace, ".vibecab"), { recursive: true });
    await writeFile(
      join(workspace, ".vibecab", "server.json"),
      JSON.stringify({
        pid: process.pid,
        cliUrl: http.url,
        httpUrl: http.url,
        mcpUrl: http.url,
        startedAt: new Date().toISOString(),
        contractVersion: "1.0",
      }),
    );
    await writeFile(input, "A bounded review input.");
    const submitExit = await main(
      ["tmr", "submit", "--workspace", workspace, "--question", "Should it proceed?", "--input", input],
      io,
    );
    expect(submitExit).toBe(0);
    const submitted: unknown = JSON.parse(output.at(-1) ?? "null"),
      demoRunId = get(submitted, "runId");
    if (typeof demoRunId !== "string") throw Error("CLI submit omitted run id");
    let status: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(await main(["tmr", "status", demoRunId, "--workspace", workspace], io)).toBe(0);
      status = JSON.parse(output.at(-1) ?? "null");
      if (get(status, "status") === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(get(status, "status")).toBe("completed");
    expect(await main(["tmr", "report", demoRunId, "--workspace", workspace, "--json"], io)).toBe(0);
    const reportExport: unknown = JSON.parse(output.at(-1) ?? "null");
    expect(get(get(reportExport, "content"), "inputMaterials")).toEqual([
      expect.objectContaining({ source: "file:proposal.md" }),
    ]);
    expect(await main(["tmr", "report", demoRunId, "--workspace", workspace, "--markdown", "--json"], io)).toBe(0);
    expect(get(JSON.parse(output.at(-1) ?? "null"), "content")).toContain("## Recommendation");
    expect(await main(["tmr", "cancel", demoRunId, "--workspace", workspace], io)).toBe(0);

    await engine.command(
      engine.trustedHostAuth("admin"),
      {
        contractVersion: CONTRACT_VERSION,
        requestId: "cli-tmr-model-settings",
      },
      {
        commandId: "cli-tmr-model-settings",
        type: "sys.SetSettings",
        payload: new Contract().read<Json>("json", { patch: { models: { default: liveModel } } }),
      },
    );
    const liveExit = await main(
      [
        "tmr",
        "submit",
        "--workspace",
        workspace,
        "--question",
        "Interrupt and resume",
        "--input",
        input,
        "--mode",
        "live",
      ],
      io,
    );
    expect(liveExit).toBe(0);
    const liveSubmitted: unknown = JSON.parse(output.at(-1) ?? "null"),
      liveRunId = get(liveSubmitted, "runId");
    if (typeof liveRunId !== "string") throw Error("CLI live submit omitted run id");
    await started;
    await engine.drain(0);
    await engine.stop();
    release();
    await http.close();
    http = undefined;
    const resumedEngine = createEngine({ modelProviders: { "openai-compatible": provider } });
    await resumedEngine.start(workspace);
    const resumedHttp = await startHttp(resumedEngine, { transport: "cli" });
    http = resumedHttp;
    await writeFile(
      join(workspace, ".vibecab", "server.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        contractVersion: "1.0",
        cliUrl: resumedHttp.url,
        httpUrl: resumedHttp.url,
        mcpUrl: resumedHttp.url,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await main(["tmr", "resume", liveRunId, "--workspace", workspace], io)).toBe(0);
    expect(errors).toEqual([]);
    await resumedEngine.stop();
  } finally {
    release();
    await http?.close();
    await engine.stop();
    await rm(workspace, { recursive: true, force: true });
    keyring.clear();
  }
});

function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}
