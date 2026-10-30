import {
  fail,
  type ExternalToolDefinition,
  type Job,
  type Json,
  type JsonSchema,
  type ToolServer,
} from "../../../contract/src/index.js";
import { AgentTriggerRuntime } from "./trigger-runtime.js";
import { ExternalTools } from "./tools/external.js";

export abstract class AgentExternalRuntime extends AgentTriggerRuntime {
  protected externalToolRuntime() {
    const store = this.available();
    return new ExternalTools(
      store,
      this.contract,
      this.deps.clock,
      this.deps.ids,
      this.deps.keyStore,
      this.deps.toolTransport,
      async (call) =>
        this.queue.run(() =>
          store.transaction(() => {
            store.saveFeedback("tool-call", call.callId, this.contract.read<Json>("json", call));
            const eventPayload = Object.fromEntries(Object.entries(call).filter(([key]) => key !== "createdAt"));
            store.appendEvent({
              ts: call.createdAt,
              type: "vc.ExternalToolCalled",
              entity: { kind: "tool_call", id: call.callId },
              payload: this.contract.read<Json>("events/vc.ExternalToolCalled", eventPayload),
            });
          }),
        ),
    );
  }

  protected async runToolServerRefresh(job: Job): Promise<void> {
    const payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const serverId = Reflect.get(payload, "serverId");
    if (typeof serverId !== "string") return;
    const store = this.available(),
      rawServer = store.feedback("tool-server", serverId);
    if (!rawServer) return;
    const server = this.contract.read<ToolServer>("tool-server", rawServer);
    if (server.status !== "connecting" || !this.deps.toolTransport) {
      if (!this.deps.toolTransport) await this.setToolServerStatus(server, "failed", []);
      return;
    }
    let session: Awaited<ReturnType<NonNullable<typeof this.deps.toolTransport>["connect"]>> | undefined;
    try {
      const credential = server.credentialRef ? await this.deps.keyStore.get(server.credentialRef) : undefined;
      session = await this.deps.toolTransport.connect(server, credential);
      const listed = await session.listTools(),
        tools: ExternalToolDefinition[] = [],
        names = new Set<string>();
      for (const candidate of listed) {
        const definition = this.contract.read<ExternalToolDefinition>("tool-definition", {
          name: candidate.name,
          ...(candidate.description === undefined ? {} : { description: candidate.description }),
          inputSchema: candidate.inputSchema,
          ...(candidate.annotations === undefined ? {} : { annotations: candidate.annotations }),
        });
        if (names.has(definition.name)) fail("invalid", "MCP server returned duplicate tool names");
        names.add(definition.name);
        const inputSchema = this.contract.read<JsonSchema>("json", definition.inputSchema);
        if (!this.contract.schemaIsValid(inputSchema)) fail("invalid", "MCP server returned an invalid tool schema");
        tools.push(definition);
      }
      const policies = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          server.policies[tool.name] ?? (tool.annotations?.readOnlyHint === true ? "allowed" : "needs_grant"),
        ]),
      );
      await this.setToolServerStatus(server, "connected", tools, policies);
    } catch {
      await this.setToolServerStatus(server, "failed", []);
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  private async setToolServerStatus(
    server: ToolServer,
    status: ToolServer["status"],
    tools: ExternalToolDefinition[],
    policies = server.policies,
  ): Promise<void> {
    const store = this.available();
    await this.queue.run(() =>
      store.transaction(() => {
        if (!this.hasToolServerJobFor(server.serverId)) return;
        const currentRaw = store.feedback("tool-server", server.serverId);
        if (!currentRaw) return;
        const current = this.contract.read<ToolServer>("tool-server", currentRaw);
        if (current.status !== "connecting") return;
        const updated = this.contract.read<ToolServer>("tool-server", {
          ...current,
          status,
          tools,
          policies,
          updatedAt: this.deps.clock.now(),
        });
        store.saveFeedback("tool-server", server.serverId, this.contract.read<Json>("json", updated));
        store.appendEvent({
          ts: updated.updatedAt,
          type: "vc.ToolServerChanged",
          entity: { kind: "tool_server", id: server.serverId },
          payload: this.contract.read<Json>("events/vc.ToolServerChanged", {
            serverId: server.serverId,
            name: server.name,
            status,
          }),
        });
      }),
    );
  }

  private hasToolServerJobFor(serverId: string): boolean {
    return this.available()
      .jobs()
      .some((job) => {
        if (job.kind !== "agent.tool_server.refresh" || job.state !== "leased") return false;
        const payload = job.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          Reflect.get(payload, "serverId") === serverId
        );
      });
  }
}
