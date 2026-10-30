import { expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpClientTransport } from "../src/index.js";
import { Contract } from "../../../contract/src/index.js";
import type { ToolServer } from "../../../contract/src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url)),
  secret = "stdio-test-secret";

function server(transport: ToolServer["transport"], credentialRef?: string): ToolServer {
  return {
    serverId: "test-server",
    name: "Test server",
    transport,
    ...(credentialRef ? { credentialRef } : {}),
    scope: {},
    status: "connected",
    tools: [],
    policies: {},
    updatedAt: "2026-10-29T00:00:00.000Z",
  };
}

it("connects over stdio, keeps the credential in its configured env variable, and exchanges MCP content", async () => {
  const transportConfig: ToolServer["transport"] = {
      kind: "stdio",
      command: process.execPath,
      args: [fixture],
      env: {
        TEST_CREDENTIAL_ENV: "VIBECAB_NOTES_TOKEN",
        UNRELATED_TEST_VALUE: "ordinary-env",
        ECHO_CREDENTIAL: "true",
      },
      credentialEnv: "VIBECAB_NOTES_TOKEN",
    },
    connection = await new McpClientTransport().connect(server(transportConfig, "notes-key"), secret);
  try {
    expect(JSON.stringify(transportConfig)).not.toContain(secret);
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["dangerous", "read_only", "unknown"]);
    expect(tools.find((tool) => tool.name === "read_only")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === "dangerous")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.find((tool) => tool.name === "unknown")?.annotations).toBeUndefined();
    const result = await connection.callTool("read_only", { value: "argument" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "fixture text" }],
      structuredContent: {
        credential: secret,
        unrelated: "ordinary-env",
        args: "argument",
      },
    });
    expect(JSON.stringify(result)).not.toContain("credentialEnv");
  } finally {
    await connection.close();
  }
});

it("requires a valid credentialEnv only when a stdio server has a keychain credential", () => {
  const contract = new Contract(),
    base = {
      name: "stdio",
      transport: { kind: "stdio", command: process.execPath, args: [] },
      scope: {},
    };
  expect(() =>
    contract.read("operations/vc.ConnectToolServer", { ...base, credentialRef: "key" }, "#/properties/payload"),
  ).toThrow();
  expect(() =>
    contract.read(
      "operations/vc.ConnectToolServer",
      { ...base, credentialRef: "key", transport: { ...base.transport, credentialEnv: "bad-name" } },
      "#/properties/payload",
    ),
  ).toThrow();
  expect(() =>
    contract.read(
      "operations/vc.ConnectToolServer",
      { ...base, transport: { ...base.transport, credentialEnv: "MCP_TOKEN" } },
      "#/properties/payload",
    ),
  ).not.toThrow();
});

it("sends HTTP credentials only as bearer authorization", async () => {
  let authorization: string | null = null;
  const serverInstance = new McpServer({ name: "http-fixture", version: "1.0.0" });
  serverInstance.registerTool("auth", { inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text" as const, text: "fixture text" }],
    structuredContent: { authorization },
  }));
  const handler = createMcpHandler(async ({ requestInfo }) => {
      authorization = requestInfo?.headers.get("authorization") ?? null;
      return serverInstance;
    }),
    http = createServer((incoming, outgoing) => {
      void (async () => {
        const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : Readable.toWeb(incoming),
          request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/mcp"}`, {
            method: incoming.method,
            headers: incoming.headers,
            ...(body ? { body, duplex: "half" } : {}),
          } as RequestInit),
          response = await handler.fetch(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => outgoing.destroy());
    });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
  const port = address.port;
  const connection = await new McpClientTransport().connect(
    server({ kind: "http", url: `http://127.0.0.1:${port}/mcp` }, "http-key"),
    secret,
  );
  try {
    const listed = await connection.listTools();
    expect(listed).toMatchObject([{ name: "auth", annotations: { readOnlyHint: true } }]);
    expect(await connection.callTool("auth", {})).toMatchObject({
      content: [{ type: "text", text: "fixture text" }],
      structuredContent: { authorization: `Bearer ${secret}` },
    });
    expect(authorization).toBe(`Bearer ${secret}`);
  } finally {
    await connection.close();
    await handler.close();
    await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
  }
});

it("surfaces a server exit during a call, closes failed connections, and rejects invalid credential env names", async () => {
  const transport = new McpClientTransport(),
    connection = await transport.connect(
      server({ kind: "stdio", command: process.execPath, args: [fixture, "exit-call"] }),
    );
  try {
    await connection.listTools();
    await expect(connection.callTool("exit_now", {})).rejects.toThrow();
  } finally {
    await connection.close();
  }
  await expect(
    transport.connect(server({ kind: "stdio", command: "vibecab-nonexistent-mcp-command-123", args: [] })),
  ).rejects.toThrow();
  const dir = await mkdtemp(join(tmpdir(), "mcp-client-connect-failure-")),
    pidFile = join(dir, "pid");
  try {
    await expect(
      transport.connect(
        server({
          kind: "stdio",
          command: process.execPath,
          args: [fixture, "exit-immediate"],
          env: { PID_FILE: pidFile },
        }),
      ),
    ).rejects.toThrow();
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await expect(
    transport.connect(
      server({ kind: "stdio", command: process.execPath, args: [fixture], credentialEnv: "bad-name" }, "key"),
      secret,
    ),
  ).rejects.toThrow();
});
