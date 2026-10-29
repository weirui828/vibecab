import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport, TransportSendOptions } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { Contract } from "../../../contract/src/index.js";
import type {
  CommandEnvelope,
  CommandResult,
  ContractError,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
} from "../../../contract/src/index.js";
import { createMcpServer } from "../src/index.js";
import { inProcess } from "../../in-process/src/index.js";
import { fixture } from "../../../engine/test/helpers.js";
import { contractSuite } from "../../../engine/test/contract/suite.js";
import type { SysCreateAccessTokenOperation } from "../../../contract/src/index.js";

type ToolMap = Record<string, { toolName: string; description: string }>;
const contract = new Contract(),
  toolMap: ToolMap = JSON.parse(readFileSync("contract/mcp-tools.json", "utf8"));

class RequestIdTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private overrideId: string | undefined;
  private readonly responseIds = new Map<string, string | number>();

  constructor(private readonly inner: Transport) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message) => {
      if (!("method" in message) && "id" in message) {
        const original = this.responseIds.get(JSON.stringify(message.id));
        if (original !== undefined) {
          this.responseIds.delete(JSON.stringify(message.id));
          Reflect.set(message, "id", original);
        }
      }
      this.onmessage?.(message);
    };
  }

  async withRequestId<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.overrideId = id;
    try {
      return await action();
    } finally {
      this.overrideId = undefined;
    }
  }

  start() {
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    if (this.overrideId && "method" in message && message.method === "tools/call" && "id" in message) {
      const original = message.id,
        requested = this.overrideId,
        rewritten = { ...message, id: requested };
      this.responseIds.set(JSON.stringify(requested), original);
      await this.inner.send(rewritten, options);
      return;
    }
    await this.inner.send(message, options);
  }

  close() {
    return this.inner.close();
  }
}

contractSuite("MCP", async () => {
  const f = await fixture(),
    issued = await inProcess(f.rawEngine).command({
      commandId: "mcp-contract-admin-token",
      type: "sys.CreateAccessToken",
      payload: { name: "MCP contract suite", channel: "mcp", scope: "collaborate" },
    });
  if (!issued.ok) throw new Error(issued.error.message);
  const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      issued.result,
      "#/properties/result",
    ).token,
    auth = { kind: "token" as const, secret: token, transport: "mcp" as const },
    server = await createMcpServer(f.rawEngine, token),
    client = new Client({ name: "vibecab-contract-suite", version: "1.0.0" }),
    [inner, serverTransport] = InMemoryTransport.createLinkedPair(),
    transport = new RequestIdTransport(inner);
  await server.connect(serverTransport);
  await client.connect(transport);
  let requestNumber = 0;
  const directCommandIds = new Set<string>();
  const metadata = () => ({ contractVersion: "1.0", requestId: `mcp-contract-${++requestNumber}` });
  const apiClient = {
    channel: "mcp" as const,
    async command(cmd: CommandEnvelope): Promise<CommandResult> {
      const payload = contract.read<Json>("json", cmd.payload),
        schemaName = "operations/" + cmd.type;
      let checkedPayload: Record<string, Json>;
      try {
        checkedPayload = contract.read<Record<string, Json>>(schemaName, payload, "#/properties/payload");
      } catch {
        directCommandIds.add(cmd.commandId);
        return f.rawEngine.command(auth, metadata(), { ...cmd, payload });
      }
      const tool = toolMap[cmd.type];
      if (!tool || directCommandIds.has(cmd.commandId))
        return f.rawEngine.command(auth, metadata(), { ...cmd, payload });
      try {
        const result = await transport.withRequestId(cmd.commandId, () =>
            client.callTool({ name: tool.toolName, arguments: checkedPayload }),
          ),
          value = parseToolResult(result);
        return result.isError
          ? { ok: false, error: contract.read<ContractError>("contract-error", value) }
          : { ok: true, result: value, seq: 0 };
      } catch {
        return f.rawEngine.command(auth, metadata(), { ...cmd, payload });
      }
    },
    async query(query: QueryEnvelope): Promise<Json> {
      const args = contract.read<Json>("json", query.args);
      let checkedArgs: Record<string, Json>;
      try {
        checkedArgs = contract.read<Record<string, Json>>("operations/" + query.name, args, "#/properties/payload");
      } catch {
        return f.rawEngine.query(auth, metadata(), { ...query, args });
      }
      const tool = toolMap[query.name];
      if (!tool) return f.rawEngine.query(auth, metadata(), { ...query, args });
      try {
        const result = await client.callTool({ name: tool.toolName, arguments: checkedArgs });
        if (result.isError) throw { contract: parseToolResult(result) };
        return parseToolResult(result);
      } catch (error) {
        if (isContractError(error)) throw error;
        throw error;
      }
    },
    subscribe(sub: Subscription): AsyncIterable<EventEnvelope> {
      return f.rawEngine.subscribe(auth, metadata(), sub);
    },
    putBlob(bytes: Uint8Array, mediaType: string): Promise<string> {
      return f.rawEngine.putBlob(auth, metadata(), bytes, mediaType);
    },
    getBlob(hash: string): Promise<Uint8Array> {
      return f.rawEngine.getBlob(auth, metadata(), hash);
    },
  };
  return {
    client: apiClient,
    close: async () => {
      await client.close();
      await server.close();
      await f.close();
    },
  };
});

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): Json {
  const content = result.content.find((item) => item.type === "text");
  if (!content || content.type !== "text") return null;
  const parsed = contract.read<Json>("json", JSON.parse(content.text));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, "result")
    ? contract.read<Json>("json", Reflect.get(parsed, "result"))
    : parsed;
}

function isContractError(value: unknown): value is { contract: { code: string; message: string; retryable: boolean } } {
  if (typeof value !== "object" || value === null) return false;
  const nested = Reflect.get(value, "contract");
  return typeof nested === "object" && nested !== null && typeof Reflect.get(nested, "code") === "string";
}
