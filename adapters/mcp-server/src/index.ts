import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMcpHandler, fromJsonSchema, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { JsonSchemaType, jsonSchemaValidator } from "@modelcontextprotocol/server";
import { CONTRACT_VERSION, Contract, errorOf, fail } from "../../../contract/src/index.js";
import type { CommandEnvelope, Json, QueryEnvelope } from "../../../contract/src/index.js";
import type { CallAuth, CallMetadata, Engine } from "../../../engine/src/engine.js";

type Scope = "read" | "collaborate" | "admin";
type OperationDefinition = { toolName: string; description: string };
type OperationAnnotation = Record<string, OperationDefinition>;

const contract = new Contract();
const annotations = loadAnnotations();
const scopeRank: Record<Scope, number> = { read: 0, collaborate: 1, admin: 2 };

function loadAnnotations(): OperationAnnotation {
  const path = fileURLToPath(new URL("../../../contract/mcp-tools.json", import.meta.url));
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error("Invalid MCP tool annotations");
  const output: OperationAnnotation = {};
  const names = new Set<string>();
  for (const [operation, value] of Object.entries(raw)) {
    if (!isRecord(value)) throw new Error("Invalid MCP tool annotation");
    const toolName = value.toolName,
      description = value.description;
    if (typeof toolName !== "string" || !/^[a-z][a-z0-9_]*$/.test(toolName) || typeof description !== "string")
      throw new Error("Invalid MCP tool annotation");
    if (names.has(toolName)) throw new Error("Duplicate MCP tool name");
    names.add(toolName);
    output[operation] = { toolName, description };
  }
  for (const [name, operation] of contract.operations) {
    if (operation.meta.channels.includes("mcp") && !output[name]) throw new Error(`Missing MCP annotation: ${name}`);
  }
  return output;
}

export function createMcpServer(engine: Engine, secret: string): Promise<McpServer> {
  const auth: CallAuth = { kind: "token", secret, transport: "mcp" },
    metadata: CallMetadata = { contractVersion: CONTRACT_VERSION, requestId: "mcp-capabilities" };
  return engine
    .query(auth, metadata, { name: "sys.Capabilities", args: {} })
    .then((rawCapabilities) => {
      const capabilities = contract.read<{
        callContext: { channel: "mcp"; scope: Scope };
      }>("operations/sys.Capabilities", rawCapabilities, "#/properties/result");
      if (capabilities.callContext.channel !== "mcp") fail("unauthenticated", "Invalid MCP access token");
      return registerServer(engine, auth, capabilities.callContext.scope);
    })
    .catch((error: unknown) => {
      const normalized = errorOf(error);
      fail(normalized.code, normalized.message, normalized.details);
    });
}

function registerServer(engine: Engine, auth: CallAuth, scope: Scope): McpServer {
  const server = new McpServer({ name: "vibecab", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const operations = [...contract.operations].filter(
    ([, operation]) => operation.meta.channels.includes("mcp") && scopeRank[operation.meta.effect] <= scopeRank[scope],
  );
  for (const [name, operation] of operations) registerOperationTool(server, engine, auth, name, operation.kind);
  registerResources(server, engine, auth);
  return server;
}

function registerOperationTool(
  server: McpServer,
  engine: Engine,
  auth: CallAuth,
  operationName: string,
  kind: "command" | "query",
) {
  const annotation = annotations[operationName];
  if (!annotation) throw new Error(`Missing MCP tool annotation: ${operationName}`);
  const operationSchema = contract.schema("operations/" + operationName),
    payloadSchema = schemaProperty(operationSchema, "payload"),
    resultSchema = schemaProperty(operationSchema, "result"),
    validator = contractValidator(operationName),
    inputSchema = fromJsonSchema<Json>(payloadSchema, validator),
    outputSchema = fromJsonSchema<Json>(resultEnvelopeSchema(resultSchema), resultValidator(operationName)),
    metadata = { contractVersion: CONTRACT_VERSION, requestId: "mcp-tool-init" };
  server.registerTool(
    annotation.toolName,
    {
      description: annotation.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: kind === "query",
        destructiveHint: false,
        ...(kind === "command" ? { idempotentHint: true, openWorldHint: false } : {}),
      },
    },
    async (payload, context) => {
      const requestId = requestIdOf(context),
        callMetadata = { ...metadata, requestId: `mcp-${requestId}` };
      try {
        const checkedPayload = contract.read<Json>("operations/" + operationName, payload, "#/properties/payload");
        if (kind === "query") {
          const result = await engine.query(auth, callMetadata, {
            name: operationName,
            args: checkedPayload,
          } satisfies QueryEnvelope);
          return toolResult(result);
        }
        const result = await engine.command(auth, callMetadata, {
          commandId: mcpCommandId(operationName, requestId),
          type: operationName,
          payload: checkedPayload,
        } satisfies CommandEnvelope);
        return result.ok ? toolResult(result.result) : toolError(result.error);
      } catch (error) {
        return toolError(errorOf(error));
      }
    },
  );
}

function contractValidator(operationName: string): jsonSchemaValidator {
  return {
    getValidator<T>() {
      return (input: unknown) => {
        try {
          const data = contract.read<T>("operations/" + operationName, input, "#/properties/payload");
          return { valid: true, data, errorMessage: undefined };
        } catch {
          return { valid: false, data: undefined, errorMessage: "Input does not match the contract schema" };
        }
      };
    },
  };
}

function resultValidator(operationName: string): jsonSchemaValidator {
  return {
    getValidator<T>() {
      return (input: unknown) => {
        try {
          const value = contract.read<Json>("json", input);
          if (!isRecord(value) || !Object.hasOwn(value, "result")) throw new Error("Missing result");
          contract.read("operations/" + operationName, value.result, "#/properties/result");
          return { valid: true, data: contract.read<T>("json", value), errorMessage: undefined };
        } catch {
          return { valid: false, data: undefined, errorMessage: "Output does not match the contract schema" };
        }
      };
    },
  };
}

function requestIdOf(context: unknown): string {
  const mcpRequest = isRecord(context) ? context.mcpReq : undefined,
    id = isRecord(mcpRequest) ? mcpRequest.id : undefined;
  if ((typeof id !== "string" && typeof id !== "number") || (typeof id === "number" && !Number.isFinite(id)))
    fail("invalid", "MCP request id is missing");
  return String(id);
}

export function mcpCommandId(operationName: string, requestId: string): string {
  return (
    "mcp-" +
    createHash("sha256")
      .update(operationName + "\0" + requestId)
      .digest("hex")
  );
}

function toolResult(value: Json) {
  const output = { result: value },
    text = JSON.stringify(output);
  return {
    content: [{ type: "text" as const, text: text ?? "null" }],
    structuredContent: output,
  };
}

function toolError(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(error) }] };
}

function registerResources(server: McpServer, engine: Engine, auth: CallAuth) {
  server.registerResource(
    "artifact-version",
    new ResourceTemplate("vibecab://artifacts/{artifactId}/versions/{version}", { list: undefined }),
    { description: "Read an artifact version as an outline and element list.", mimeType: "application/json" },
    async (uri, variables) => {
      const artifactId = variables.artifactId,
        version = Number(variables.version);
      if (typeof artifactId !== "string" || !Number.isSafeInteger(version) || version < 1)
        fail("invalid", "Invalid artifact version URI");
      const metadata = { contractVersion: CONTRACT_VERSION, requestId: `mcp-resource-${artifactId}-${version}` },
        [outline, elements] = await Promise.all([
          engine.query(auth, metadata, { name: "vc.Outline", args: { artifactId, version } }),
          engine.query(auth, metadata, { name: "vc.Elements", args: { artifactId, version } }),
        ]);
      return resourceContents(uri.href, { artifactId, version, outline, elements });
    },
  );

  server.registerResource(
    "thread",
    new ResourceTemplate("vibecab://threads/{threadId}", { list: undefined }),
    { description: "Read a collaboration thread and its comments.", mimeType: "application/json" },
    async (uri, variables) => {
      const threadId = variables.threadId;
      if (typeof threadId !== "string" || !threadId) fail("invalid", "Invalid thread URI");
      const metadata = { contractVersion: CONTRACT_VERSION, requestId: `mcp-thread-resource-${threadId}` },
        sessionsRaw = await engine.query(auth, metadata, { name: "vc.Sessions", args: {} }),
        sessions = contract.read<Array<{ sessionId: string }>>(
          "operations/vc.Sessions",
          sessionsRaw,
          "#/properties/result",
        );
      for (const session of sessions) {
        const threadsRaw = await engine.query(auth, metadata, {
            name: "vc.Threads",
            args: { sessionId: session.sessionId },
          }),
          threads = contract.read<Array<{ threadId: string }>>(
            "operations/vc.Threads",
            threadsRaw,
            "#/properties/result",
          ),
          thread = threads.find((candidate) => candidate.threadId === threadId);
        if (thread) return resourceContents(uri.href, thread);
      }
      fail("not_found", "Thread not found");
    },
  );
}

function resourceContents(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
}

function schemaProperty(schema: unknown, name: string): JsonSchemaType {
  if (!isRecord(schema) || !isRecord(schema.properties)) throw new Error("Invalid operation schema");
  const property = schema.properties[name];
  if (!isRecord(property)) throw new Error("Missing operation schema property");
  return property as JsonSchemaType;
}

function resultEnvelopeSchema(result: JsonSchemaType): JsonSchemaType {
  return {
    type: "object",
    properties: { result },
    required: ["result"],
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface McpHttpOptions {
  port?: number;
  appOrigin?: string;
}

const statusFor = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_base: 409,
  locked: 423,
  budget_exceeded: 402,
  rate_limited: 429,
  unsupported: 501,
  unavailable: 503,
  uncertain: 503,
  internal: 500,
} as const;

function bearer(header: string | undefined): string {
  if (!header?.startsWith("Bearer ") || header.length <= 7) fail("unauthenticated", "MCP access token required");
  return header.slice(7);
}

export function validateMcpLocalRequest(
  hostHeader: string | undefined,
  origin: string | undefined,
  port: number,
  appOrigin?: string,
): void {
  if (!["127.0.0.1:" + port, "localhost:" + port].includes(hostHeader ?? "")) fail("forbidden", "Invalid Host");
  if (origin !== undefined && origin !== appOrigin) fail("forbidden", "Origin is not permitted");
}

export function createMcpHttpHandler(engine: Engine) {
  let requestNumber = 0;
  const handler = createMcpHandler(async ({ requestInfo }) => {
    const secret = bearer(requestInfo?.headers.get("authorization") ?? undefined);
    return createMcpServer(engine, secret);
  });
  return {
    fetch: async (request: Request) => {
      try {
        const secret = bearer(request.headers.get("authorization") ?? undefined),
          auth: CallAuth = { kind: "token", secret, transport: "mcp" };
        await engine.query(
          auth,
          {
            contractVersion: request.headers.get("x-contract-version") ?? CONTRACT_VERSION,
            requestId: `mcp-http-auth-${++requestNumber}`,
          },
          { name: "sys.Capabilities", args: {} },
        );
        return await handler.fetch(request);
      } catch (error) {
        const normalized = errorOf(error);
        return Response.json(normalized, {
          status: statusFor[normalized.code],
          headers: { "Cache-Control": "no-store" },
        });
      }
    },
    close: () => handler.close(),
  };
}

export async function startMcpHttp(engine: Engine, options: McpHttpOptions = {}) {
  const host = "127.0.0.1";
  let port = 0;
  const handler = createMcpHttpHandler(engine);
  const server = createServer((incoming, response) => {
    void handle(incoming, response).catch((error: unknown) => {
      const normalized = errorOf(error);
      sendJson(response, statusFor[normalized.code], normalized);
    });
  });

  async function handle(incoming: IncomingMessage, response: ServerResponse) {
    validateMcpLocalRequest(incoming.headers.host, incoming.headers.origin, port, options.appOrigin);
    const url = new URL(incoming.url ?? "/", `http://${host}:${port}`);
    if (url.pathname !== "/mcp" || !["POST", "GET", "DELETE"].includes(incoming.method ?? "")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    if (incoming.method === "POST") {
      for await (const chunk of incoming) {
        if (!Buffer.isBuffer(chunk)) fail("invalid", "Invalid MCP request body");
        length += chunk.length;
        if (length > 16 * 1024 * 1024) fail("invalid", "MCP request body exceeds 16 MiB");
        chunks.push(chunk);
      }
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const request = new Request(`http://${host}:${port}/mcp`, {
      method: incoming.method,
      headers,
      ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    const result = await handler.fetch(request);
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(Buffer.from(await result.arrayBuffer()));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("MCP server failed to bind"));
      port = address.port;
      resolve();
    });
  });
  return {
    url: `http://${host}:${port}/mcp`,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
