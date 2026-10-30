import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { JsonSchemaType, jsonSchemaValidator } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Contract } from "../../contract/src/index.js";
import type { JsonSchema } from "../../contract/src/index.js";

export async function serveMcpRelayStdio(mcpUrl: string, secret: string) {
  const client = new Client({ name: "vibecab-mcp-relay", version: "0.1.0" }),
    contract = new Contract(),
    transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
  await client.connect(transport);
  transport.onclose = () => {
    process.stderr.write("VibeCab MCP host disconnected\n");
    process.exitCode = 1;
    process.stdin.pause();
  };
  const server = new McpServer({ name: "vibecab", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } }),
    { tools } = await client.listTools();
  for (const tool of tools) {
    const inputSchema = contract.read<JsonSchema>("json", tool.inputSchema),
      outputSchema = tool.outputSchema ? contract.read<JsonSchema>("json", tool.outputSchema) : undefined;
    if (!contract.schemaIsValid(inputSchema) || (outputSchema && !contract.schemaIsValid(outputSchema)))
      throw Error("Host MCP endpoint returned an invalid tool schema");
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(inputSchema as JsonSchemaType, schemaValidator(contract, inputSchema)),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(outputSchema
          ? { outputSchema: fromJsonSchema(outputSchema as JsonSchemaType, schemaValidator(contract, outputSchema)) }
          : {}),
      },
      (input) => client.callTool({ name: tool.name, arguments: isRecord(input) ? input : {} }),
    );
  }
  const resources = await client.listResources();
  for (const resource of resources.resources)
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      (uri) => client.readResource({ uri: uri.href }),
    );
  const templates = await client.listResourceTemplates();
  for (const template of templates.resourceTemplates)
    server.registerResource(
      template.name,
      new ResourceTemplate(template.uriTemplate, { list: undefined }),
      { description: template.description, mimeType: template.mimeType },
      (uri) => client.readResource({ uri: uri.href }),
    );
  const handle = serveStdio(() => server, {
    onerror: (error) => process.stderr.write(`VibeCab MCP relay error: ${error.name}\n`),
  });
  process.stdin.once("end", () => void client.close());
  process.once("SIGINT", () => void handle.close().finally(() => client.close()));
  process.once("SIGTERM", () => void handle.close().finally(() => client.close()));
  return handle;
}

function schemaValidator(contract: Contract, schema: JsonSchema): jsonSchemaValidator {
  return {
    getValidator<T>() {
      return (value: unknown) => {
        const valid = contract.validates(schema, value);
        return valid
          ? { valid: true as const, data: value as T }
          : { valid: false as const, data: undefined, errorMessage: "Input does not match the host schema" };
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
