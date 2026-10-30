import { createHash } from "node:crypto";
import { Contract, fail } from "../../../../contract/src/index.js";
import type { Json, JsonSchema, ToolServer, ToolCall, ExternalToolDefinition } from "../../../../contract/src/index.js";
import type { Clock, IdGenerator } from "../../dependencies.js";
import type { KeyStore } from "../../gateway/types.js";
import type { Repository } from "../../storage/repository.js";
import type { ToolTransport } from "../tool-transport.js";
import { canonical } from "../../content/hash.js";

export interface OfferedExternalTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  serverId: string;
  tool: string;
}

export interface ExternalToolResult {
  content: string;
  log: Omit<ToolCall, "callId" | "turnId" | "createdAt">;
  manifest: {
    kind: "tool_result";
    id: string;
    hash: string;
    tokens: number;
    reason: string;
    serverId: string;
    tool: string;
    argsHash: string;
    resultHash: string;
    bytes: number;
    originalBytes: number;
    truncatedBytes: number;
  };
}

export function untrustedMcpResult(serverId: string, tool: string, content: string): string {
  const escapeAttribute = (value: string) =>
      value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    safeContent = content.replaceAll("<", "\\u003c");
  return `<untrusted-mcp-result server="${escapeAttribute(serverId)}" tool="${escapeAttribute(tool)}">\n${safeContent}\n</untrusted-mcp-result>`;
}

export class ExternalTools {
  constructor(
    private readonly store: Repository,
    private readonly contract: Contract,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly keyStore: KeyStore,
    private readonly transport: ToolTransport | undefined,
    private readonly record: (call: ToolCall) => Promise<void>,
  ) {}

  offered(sessionId: string, mode: "reply" | "update"): OfferedExternalTool[] {
    const session = this.contract.read<Record<string, Json>>("session", this.store.feedback("session", sessionId)),
      projectId = session.primaryProjectId;
    const result: OfferedExternalTool[] = [];
    for (const raw of this.store.feedbackList("tool-server")) {
      const server = this.contract.read<ToolServer>("tool-server", raw);
      if (server.status !== "connected" || !scopeIncludes(server, sessionId, projectId)) continue;
      for (const tool of server.tools) {
        const policy = policyFor(server, tool),
          readonly = tool.annotations?.readOnlyHint === true;
        if (policy === "blocked" || (mode === "update" && (!readonly || policy !== "allowed"))) continue;
        if (
          policy === "needs_grant" &&
          !hasToolGrant(this.store, this.contract, this.clock, sessionId, server.serverId, tool.name)
        )
          continue;
        const parameters = this.contract.read<JsonSchema>("json", tool.inputSchema);
        if (!this.contract.schemaIsValid(parameters)) continue;
        result.push({
          name: modelToolName(server.serverId, tool.name),
          description: tool.description ?? `External MCP tool ${tool.name}`,
          parameters,
          serverId: server.serverId,
          tool: tool.name,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(
    turnId: string,
    sessionId: string,
    mode: "reply" | "update",
    offered: OfferedExternalTool,
    args: unknown,
    timeoutMs: number,
    byteLimit: number,
  ): Promise<ExternalToolResult> {
    const transport = this.transport;
    if (!transport) fail("unavailable", "External MCP tool transport is not configured");
    const serverRaw = this.store.feedback("tool-server", offered.serverId);
    if (!serverRaw) fail("not_found", "External tool server not found");
    const server = this.contract.read<ToolServer>("tool-server", serverRaw),
      tool = server.tools.find((candidate) => candidate.name === offered.tool);
    if (!tool || server.status !== "connected" || !scopeIncludes(server, sessionId, this.sessionProject(sessionId)))
      fail("forbidden", "External tool is outside this turn's scope");
    const policy = policyFor(server, tool);
    if (
      policy === "blocked" ||
      (mode === "update" && (policy !== "allowed" || tool.annotations?.readOnlyHint !== true)) ||
      (policy === "needs_grant" &&
        (mode === "update" ||
          !hasToolGrant(this.store, this.contract, this.clock, sessionId, server.serverId, tool.name)))
    )
      fail("forbidden", "External tool policy does not permit this call");
    const schema = this.contract.read<JsonSchema>("json", tool.inputSchema);
    if (!this.contract.validates(schema, args)) fail("invalid", "External tool arguments failed schema validation");
    const argsJson = this.contract.read<Json>("json", args),
      argsText = canonical(argsJson),
      argsHash = sha(argsText),
      requestBytes = Buffer.byteLength(argsText),
      start = this.clock.now(),
      callId = this.ids.next("tool_call_");
    let outcome: ToolCall["outcome"] = "error",
      responseText: string,
      resultHash: string | undefined,
      resultBytes: number | undefined,
      truncatedBytes: number | undefined;
    let sessionTransport: Awaited<ReturnType<ToolTransport["connect"]>> | undefined;
    let timedOut = false;
    try {
      const operation = (async () => {
        const credential = server.credentialRef ? await this.keyStore.get(server.credentialRef) : undefined;
        sessionTransport = await transport.connect(server, credential);
        if (timedOut) {
          await sessionTransport.close();
          return undefined;
        }
        return sessionTransport.callTool(tool.name, argsJson);
      })();
      const raw = await timed(operation, timeoutMs);
      if (raw.timedOut) {
        timedOut = true;
        outcome = "timeout";
        responseText = "External tool call timed out.";
      } else {
        const serialized = safeJson(raw.value, this.contract);
        resultHash = sha(serialized);
        resultBytes = Buffer.byteLength(serialized);
        const truncated = truncateUtf8(serialized, byteLimit);
        responseText = truncated.text;
        truncatedBytes = Buffer.byteLength(truncated.text);
        outcome = isToolError(raw.value) ? "error" : "success";
      }
    } catch {
      responseText = "External tool call failed.";
    } finally {
      await sessionTransport?.close().catch(() => undefined);
    }
    const end = this.clock.now(),
      durationMs = Math.max(0, Date.parse(end) - Date.parse(start)),
      log: Omit<ToolCall, "callId" | "turnId" | "createdAt"> = {
        serverId: server.serverId,
        tool: tool.name,
        argsHash,
        ...(resultHash ? { resultHash } : {}),
        requestBytes,
        ...(resultBytes === undefined ? {} : { resultBytes }),
        durationMs,
        outcome,
      };
    await this.record(this.contract.read<ToolCall>("tool-call", { callId, turnId, createdAt: end, ...log }));
    const manifest = {
      kind: "tool_result" as const,
      id: callId,
      hash: sha(responseText),
      tokens: Math.ceil(responseText.length / 3),
      reason: "external MCP tool result",
      serverId: server.serverId,
      tool: tool.name,
      argsHash,
      resultHash: resultHash ?? sha(responseText),
      bytes: resultBytes ?? Buffer.byteLength(responseText),
      originalBytes: resultBytes ?? Buffer.byteLength(responseText),
      truncatedBytes: truncatedBytes ?? Buffer.byteLength(responseText),
    };
    return { content: responseText, log, manifest };
  }

  private sessionProject(sessionId: string): string | undefined {
    const value = this.store.feedback("session", sessionId);
    if (!value) return undefined;
    const session = this.contract.read<Record<string, Json>>("session", value);
    return typeof session.primaryProjectId === "string" ? session.primaryProjectId : undefined;
  }
}

export function policyFor(
  server: Pick<ToolServer, "policies">,
  tool: Pick<ExternalToolDefinition, "name" | "annotations">,
): "allowed" | "needs_grant" | "blocked" {
  return server.policies[tool.name] ?? (tool.annotations?.readOnlyHint === true ? "allowed" : "needs_grant");
}

export function scopeIncludes(
  server: Pick<ToolServer, "scope">,
  sessionId: string,
  projectId: Json | undefined,
): boolean {
  const { sessionIds, projectIds } = server.scope;
  if (sessionIds === undefined && projectIds === undefined) return true;
  return !!(
    (sessionIds?.includes(sessionId) ?? false) ||
    (typeof projectId === "string" && (projectIds?.includes(projectId) ?? false))
  );
}

function hasToolGrant(
  store: Repository,
  contract: Contract,
  clock: Clock,
  sessionId: string,
  serverId: string,
  tool: string,
): boolean {
  const session = contract.read<Record<string, Json>>("session", store.feedback("session", sessionId)),
    artifacts = store
      .feedbackList("attachment")
      .map((raw) => contract.read<{ sessionId: string; artifactId: string }>("session-artifact", raw))
      .filter((attachment) => attachment.sessionId === sessionId)
      .map((attachment) => attachment.artifactId);
  return store.feedbackList("grant").some((raw) => {
    const grant = contract.read<import("../../../../contract/src/index.js").Grant>("grant", raw),
      scope = grant.scope,
      inScope =
        (scope.sessionIds === undefined || scope.sessionIds.includes(sessionId)) &&
        (scope.artifactIds === undefined || artifacts.some((id) => scope.artifactIds?.includes(id) === true));
    return (
      inScope &&
      grant.capabilities.includes("use_tool") &&
      (grant.tools ?? []).some((allowed) => allowed.serverId === serverId && allowed.tool === tool) &&
      grant.revokedAt === undefined &&
      (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > Date.parse(clock.now())) &&
      session.sessionId === sessionId
    );
  });
}

export function modelToolName(serverId: string, tool: string): string {
  const suffix = tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 36) || "tool";
  return `mcp_${sha(serverId).slice(0, 8)}_${sha(tool).slice(0, 8)}_${suffix}`;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeJson(value: unknown, contract: Contract): string {
  try {
    const checked: unknown = JSON.parse(JSON.stringify(value));
    return canonical(contract.read<Json>("json", checked));
  } catch {
    return "null";
  }
}

function isToolError(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "isError") === true;
}

function truncateUtf8(value: string, limit: number): { text: string } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value };
  let end = Math.max(0, limit);
  while (end > 0) {
    try {
      const prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return { text: prefix + "…[truncated]" };
    } catch {
      end -= 1;
    }
  }
  return { text: "…[truncated]" };
}

async function timed<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
