import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ExternalToolDefinition, ToolServer } from "../../../contract/src/index.js";
import type { ToolTransport, ExternalToolSession } from "../../../engine/src/agent/tool-transport.js";

export class McpClientTransport implements ToolTransport {
  async connect(server: ToolServer, credential?: string): Promise<ExternalToolSession> {
    const client = new Client({ name: "vibecab-agent", version: "0.1.0" });
    if (server.transport.kind === "http") {
      const url = new URL(server.transport.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported MCP URL scheme");
      const transport = new StreamableHTTPClientTransport(url, {
        ...(credential ? { requestInit: { headers: { authorization: `Bearer ${credential}` } } } : {}),
      });
      await client.connect(transport);
      return session(client);
    }
    const env = { ...server.transport.env, ...(credential ? { VIBECAB_MCP_TOKEN: credential } : {}) },
      transport = new StdioClientTransport({
        command: server.transport.command,
        args: server.transport.args,
        ...(Object.keys(env).length ? { env } : {}),
      });
    await client.connect(transport);
    return session(client);
  }
}

function session(client: Client): ExternalToolSession {
  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      })) satisfies ExternalToolDefinition[];
    },
    callTool(name, arguments_) {
      return client.callTool({ name, arguments: objectArguments(arguments_) });
    },
    close() {
      return client.close();
    },
  };
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
