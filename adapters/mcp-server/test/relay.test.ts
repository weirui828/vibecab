import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";
import { CONTRACT_VERSION, Contract, type SysCreateAccessTokenOperation } from "../../../contract/src/index.js";
import { fixture } from "../../../engine/test/helpers.js";
import { startMcpHttp } from "../src/index.js";

const relayBin = resolve("dist/adapters/mcp-server/bin/vibecab-mcp.mjs");

it("relays MCP over stdio, starts a stopped host and leaves the workspace lock alone", async () => {
  const f = await fixture(),
    tokenResult = await f.rawEngine.command(
      f.rawEngine.inProcessAuth,
      {
        contractVersion: CONTRACT_VERSION,
        requestId: "relay-test-token",
      },
      {
        commandId: "relay-test-token",
        type: "sys.CreateAccessToken",
        payload: { name: "relay test", channel: "mcp", scope: "read" },
      },
    );
  if (!tokenResult.ok) throw new Error(tokenResult.error.message);
  const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
    "operations/sys.CreateAccessToken",
    tokenResult.result,
    "#/properties/result",
  ).token;
  let server: Awaited<ReturnType<typeof startMcpHttp>> | undefined,
    direct: Client | undefined,
    relay: Client | undefined,
    relayTransport: StdioClientTransport | undefined,
    relayStderr = "";
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-relay-e2e-"));
  try {
    server = await startMcpHttp(f.rawEngine);
    const hostEntry = join(workspace, "fake-host.mjs");
    await writeFile(
      hostEntry,
      `import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dir = join(process.argv[process.argv.indexOf('--workspace') + 1], '.vibecab');
await mkdir(dir, { recursive: true });
const file = join(dir, 'server.json');
await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), contractVersion: '1.0', httpUrl: 'http://127.0.0.1:1', cliUrl: 'http://127.0.0.1:2', mcpUrl: ${JSON.stringify(server.url)} }), { mode: 0o600 });
process.once('SIGTERM', async () => { await rm(file, { force: true }); process.exit(0); });
await new Promise(() => setInterval(() => undefined, 1000));\n`,
    );
    direct = new Client({ name: "direct-mcp-test", version: "1.0.0" });
    await direct.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    relayTransport = new StdioClientTransport({
      command: process.execPath,
      args: [relayBin],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        VIBECAB_DEV: "1",
        VIBECAB_WORKSPACE: workspace,
        VIBECAB_MCP_TOKEN: token,
        VIBECAB_HOST_ENTRY: hostEntry,
      },
    });
    relayTransport.stderr?.on("data", (part: Buffer | string) => (relayStderr += String(part)));
    relay = new Client({ name: "stdio-relay-test", version: "1.0.0" });
    await relay.connect(relayTransport).catch((error: unknown) => {
      throw new Error(`Relay connection failed: ${String(error)}; stderr=${relayStderr}`);
    });
    const directTools = await direct.listTools(),
      relayTools = await relay.listTools();
    expect(relayTools.tools.map((tool) => tool.name)).toEqual(directTools.tools.map((tool) => tool.name));
    const toolDefinition = directTools.tools.find((tool) => tool.name === "capabilities");
    if (!toolDefinition) throw new Error("MCP capabilities tool is missing");
    const relayedResult = await relay.callTool(
        { name: "capabilities", arguments: {} },
        { toolDefinition: { ...toolDefinition, outputSchema: undefined } },
      ),
      directResult = await direct.callTool(
        { name: "capabilities", arguments: {} },
        { toolDefinition: { ...toolDefinition, outputSchema: undefined } },
      );
    expect(relayedResult, JSON.stringify(relayedResult)).toEqual(directResult);
    const runtime = JSON.parse(await readFile(join(workspace, ".vibecab", "server.json"), "utf8")) as { pid: number };
    expect(runtime.pid).not.toBe(process.pid);
    expect(await readFile(join(workspace, ".vibecab", "start.lock")).catch(() => undefined)).toBeUndefined();
  } finally {
    await relay?.close();
    await relayTransport?.close();
    await direct?.close();
    const runtime = await readFile(join(workspace, ".vibecab", "server.json"), "utf8").catch(() => "");
    if (runtime) {
      const { stop } = await import("../../../host/src/index.js");
      await stop(workspace);
    }
    await server?.close();
    await f.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("exits with one stderr line when a live host endpoint is unavailable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-relay-down-"));
  try {
    await mkdir(join(workspace, ".vibecab"), { recursive: true });
    await writeFile(
      join(workspace, ".vibecab", "server.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        contractVersion: "1.0",
        httpUrl: "http://127.0.0.1:1",
        cliUrl: "http://127.0.0.1:2",
        mcpUrl: "http://127.0.0.1:1/mcp",
      }),
    );
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
      const child = spawn(process.execPath, [relayBin], {
        env: { ...process.env, VIBECAB_WORKSPACE: workspace, VIBECAB_MCP_TOKEN: "invalid-token" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (part: string) => (stderr += part));
      child.once("close", (code) => resolveResult({ code, stderr }));
      child.stdin.end();
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/^VibeCab MCP relay failed: \w+\n$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
