import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import type { SysCreateAccessTokenOperation } from "../../contract/src/index.js";
import { startHttp } from "../../adapters/http/src/index.js";
import { createEngine } from "../src/engine.js";
import { MemoryKeyStore } from "../src/gateway/keys.js";
import { OpenAICompatibleProvider } from "../src/gateway/providers/openai-compatible.js";
import type { Dependencies } from "../src/dependencies.js";

const metadata = { contractVersion: "1.0", requestId: "provider-key-test" };

it.each(["http", "cli"] as const)(
  "stores provider keys through the %s command without persisting the secret",
  async (transport) => {
    const workspace = await mkdtemp(join(tmpdir(), "vibecab-provider-key-")),
      keyStore = new MemoryKeyStore(),
      engine = createEngine({ keyStore } as Partial<Dependencies>);
    await engine.start(workspace);
    const auth = engine.inProcessAuth;
    const settings = await engine.command(auth, metadata, {
      commandId: `${transport}-provider-settings`,
      type: "sys.SetSettings",
      payload: {
        patch: {
          models: {
            default: {
              provider: "openai-compatible",
              baseUrl: "https://provider.example.test/v1",
              model: "test-model",
              capabilities: {
                tools: false,
                jsonSchemaOutput: false,
                streaming: true,
                maxContextTokens: 1024,
                reportsUsage: false,
              },
              pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
            },
          },
        },
      },
    });
    expect(settings.ok).toBe(true);
    const tokenResult = await engine.command(auth, metadata, {
      commandId: `${transport}-provider-key-token`,
      type: "sys.CreateAccessToken",
      payload: { name: "provider key test", channel: transport, scope: "admin" },
    });
    if (!tokenResult.ok) throw Error(tokenResult.error.message);
    const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      tokenResult.result,
      "#/properties/result",
    ).token;
    const server = await startHttp(engine, { transport });
    const secret = `provider-secret-${transport}-do-not-persist`;
    try {
      const response = await fetch(`${server.url}/v1/commands/sys.SetProviderKey`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: `${transport}-provider-key`, payload: { alias: "default", secret } }),
      });
      const result: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(result).toMatchObject({ ok: true, result: { alias: "default", keyRef: "provider:default" } });
      expect(await keyStore.get("provider:default")).toBe(secret);
      const rejected = await engine.command(auth, metadata, {
        commandId: `${transport}-provider-key-missing-alias`,
        type: "sys.SetProviderKey",
        payload: { alias: "missing", secret },
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(rejected)).not.toContain(secret);

      let authorization = "";
      const provider = new OpenAICompatibleProvider(keyStore, async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      });
      const stored = await engine.query(auth, metadata, { name: "sys.Settings", args: {} });
      const model = new Contract().read<{
        models: Record<string, import("../../contract/src/index.js").ProviderModel>;
      }>("operations/sys.Settings", stored, "#/properties/result").models.default!;
      for await (const _event of provider.call(
        model,
        { modelRef: "default", messages: [{ role: "user", content: "test" }], maxOutputTokens: 1 },
        { reservationId: "key-test", signal: new AbortController().signal },
      ))
        void _event;
      expect(authorization).toBe(`Bearer ${secret}`);

      const mcpTokenResult = await engine.command(auth, metadata, {
        commandId: `${transport}-mcp-token`,
        type: "sys.CreateAccessToken",
        payload: { name: "MCP key test", channel: "mcp", scope: "collaborate" },
      });
      if (!mcpTokenResult.ok) throw Error(mcpTokenResult.error.message);
      const mcpToken = new Contract().read<SysCreateAccessTokenOperation["result"]>(
        "operations/sys.CreateAccessToken",
        mcpTokenResult.result,
        "#/properties/result",
      ).token;
      const forbidden = await engine.command({ kind: "token", secret: mcpToken, transport: "mcp" }, metadata, {
        commandId: `${transport}-mcp-set-key`,
        type: "sys.SetProviderKey",
        payload: { alias: "default", secret },
      });
      expect(forbidden).toMatchObject({ ok: false, error: { code: "forbidden" } });

      await engine.stop();
      const files = await readTree(workspace),
        disk = files.map((bytes) => bytes.toString("utf8")).join("\n");
      expect(disk).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(forbidden)).not.toContain(secret);
    } finally {
      await server.close();
      await engine.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

async function readTree(path: string): Promise<Buffer[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return Promise.all(
    entries.flatMap((entry) => {
      const target = join(path, entry.name);
      return entry.isDirectory() ? [readTree(target).then((nested) => Buffer.concat(nested))] : [readFile(target)];
    }),
  );
}
