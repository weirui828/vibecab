/* eslint max-lines: ["error", { "max": 620 }] */
import type {
  Json,
  AgentTurn,
  ContextManifest,
  ExternalToolDefinition,
  FeedbackComment,
  JsonSchema,
  Job,
  SessionDigest,
  ToolServer,
} from "../../../contract/src/index.js";
import { readFile } from "node:fs/promises";
import { errorOf, fail } from "../../../contract/src/index.js";
import { outline } from "../content/diff.js";
import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import { createHash } from "node:crypto";
import type { ModelEvent as GatewayEvent, ModelRequest as GatewayRequest } from "../gateway/types.js";
import { replyToolNames, replyToolSchemas } from "./tools.js";
import { AgentTriggerRuntime } from "./trigger-runtime.js";
import { ExternalTools, untrustedMcpResult } from "./tools/external.js";

export abstract class AgentRuntime extends AgentTriggerRuntime {
  protected async runReply(job: Job): Promise<void> {
    const payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) fail("invalid", "Invalid agent job");
    const turnId = Reflect.get(payload, "turnId");
    if (typeof turnId !== "string") fail("invalid", "Invalid agent job");
    const turn = this.contract.read<AgentTurn>("agent-turn", this.available().feedback("agent-turn", turnId));
    await this.serializeSession(turn.sessionId, () => this.runReplyWork(job));
  }

  protected async runReplyWork(job: Job): Promise<void> {
    const store = this.available(),
      payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) fail("invalid", "Invalid agent job");
    const turnId = Reflect.get(payload, "turnId"),
      modelRef = Reflect.get(payload, "modelRef");
    if (typeof turnId !== "string" || typeof modelRef !== "string") fail("invalid", "Invalid agent job");
    const turn = this.contract.read<AgentTurn>("agent-turn", store.feedback("agent-turn", turnId));
    const selected = turn.trigger.commentIds
      .map((id) => store.feedback("comment", id))
      .filter((x): x is Json => x !== undefined)
      .map((x) => this.contract.read<FeedbackComment>("feedback-comment", x));
    const digest = store
      .feedbackList("digest")
      .map((value) => this.contract.read<SessionDigest>("session-digest", value))
      .filter((value) => value.sessionId === turn.sessionId)
      .sort((a, b) => b.version - a.version)[0];
    const prompt = await readFile(new URL("./prompts/reply.md", import.meta.url), "utf8");
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const messages: GatewayRequest["messages"] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content:
          (digest ? `<derived-session-digest>\n${JSON.stringify(digest)}\n</derived-session-digest>\n` : "") +
          "<untrusted-comments>\n" +
          selected.map((c) => `${c.author.kind}: ${c.body}`).join("\n") +
          "\n</untrusted-comments>",
      },
    ];
    const manifestId = turn.manifestId;
    const manifest = this.contract.read<ContextManifest>("context-manifest", {
      manifestId,
      turnId,
      requestIndex: 0,
      items: [
        {
          kind: "system_prompt",
          id: "reply.md",
          hash: promptHash,
          tokens: Math.ceil(prompt.length / 3),
          reason: "reply prompt",
        },
        ...selected.map((c) => ({
          kind: "comment" as const,
          id: c.commentId,
          hash: createHash("sha256").update(JSON.stringify(c)).digest("hex"),
          tokens: Math.ceil(c.body.length / 3),
          reason: "triggering comment",
        })),
        ...(digest
          ? [
              {
                kind: "digest" as const,
                id: digest.digestId,
                version: digest.version,
                hash: createHash("sha256").update(JSON.stringify(digest)).digest("hex"),
                tokens: Math.ceil(JSON.stringify(digest).length / 3),
                reason: "latest derived session digest",
              },
            ]
          : []),
      ],
      dropped: [],
      promptHash,
      createdAt: this.deps.clock.now(),
    });
    await this.queue.run(() =>
      store.transaction(() => store.saveFeedback("manifest", manifestId, this.contract.read<Json>("json", manifest))),
    );
    const toolNames = replyToolNames,
      externalTools = this.externalToolRuntime(),
      offeredExternal = externalTools.offered(turn.sessionId, "reply"),
      externalByName = new Map(offeredExternal.map((tool) => [tool.name, tool]));
    const schemas = replyToolSchemas(this.contract);
    const turnLimit =
      this.settings().sessions[turn.sessionId]?.tokenLimit ?? this.settings().budgets.defaultTurnTokenLimit ?? 8192;
    const request: GatewayRequest = {
      modelRef,
      messages,
      tools: [
        ...toolNames.map((name) => ({
          name,
          description: name.replaceAll("_", " "),
          parameters: schemas.get(name)!,
        })),
        ...offeredExternal.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      ],
      maxOutputTokens: Math.min(1200, turnLimit),
    };
    if (estimateInputTokens(request) + request.maxOutputTokens > turnLimit)
      fail("budget_exceeded", "Reply context exceeds its configured token limit");
    const model = this.settings().models[modelRef];
    if (!model) {
      await this.queue.run(() =>
        store.transaction(() =>
          store.saveFeedback(
            "agent-turn",
            turnId,
            this.contract.read<Json>("json", {
              ...turn,
              status: "failed",
              errorCode: "unsupported",
              completedAt: this.deps.clock.now(),
            }),
          ),
        ),
      );
      return;
    }
    const reservationId = this.deps.ids.next("reservation_");
    const amount = estimateReservationMicros(request, model);
    this.budgets?.reserve(
      reservationId,
      [{ kind: "turn", key: turnId }, { kind: "session", key: turn.sessionId }, { kind: "daily" }],
      amount,
    );
    const abort = new AbortController(),
      events: GatewayEvent[] = [];
    try {
      const onSent = async () =>
        this.queue.run(() =>
          store.transaction(() => {
            if (!this.hasJobLease(job)) throw Error("Agent job lease expired");
            const current = this.contract.read<AgentTurn>("agent-turn", store.feedback("agent-turn", turnId));
            store.saveFeedback(
              "agent-turn",
              turnId,
              this.contract.read<Json>("json", {
                ...current,
                status: "running",
              }),
            );
            for (const c of selected)
              store.saveFeedback(
                "delivery-state",
                c.commentId,
                this.contract.read<Json>("delivery-state", {
                  commentId: c.commentId,
                  state: "delivered",
                  turnId,
                  updatedAt: this.deps.clock.now(),
                }),
              );
          }),
        );
      for await (const event of this.gateway!.call(request, {
        reservationId,
        idempotencyKey: turnId + ":0",
        signal: abort.signal,
        onSent,
      }))
        events.push(event);
      const toolResults: Array<{ id: string; content: string; name: string }> = [];
      const externalManifests: ContextManifest["items"] = [];
      let toolCount = 0;
      for (const event of events)
        if (event.type === "tool_call") {
          toolCount++;
          if (
            toolCount >
            (this.settings().sessions[turn.sessionId]?.toolCallLimit ?? this.settings().budgets.toolCallLimit ?? 12)
          ) {
            toolResults.push({
              id: event.call.id,
              name: event.call.name,
              content: "Tool call limit reached.",
            });
            continue;
          }
          const external = externalByName.get(event.call.name),
            schema = external?.parameters ?? schemas.get(event.call.name);
          if (schema === undefined || !this.contract.validates(schema, event.call.arguments)) {
            toolResults.push({
              id: event.call.id,
              name: event.call.name,
              content: "Unknown tool or invalid arguments.",
            });
            continue;
          }
          const args = this.contract.read<Record<string, Json>>("json", event.call.arguments);
          let result: unknown = { error: "Tool could not be completed." };
          if (external) {
            const settings = this.settings().budgets,
              outcome = await externalTools.call(
                turnId,
                turn.sessionId,
                "reply",
                external,
                args,
                settings.toolTimeoutMs ?? 20_000,
                settings.toolResultByteLimit ?? 32_768,
              );
            result = untrustedMcpResult(external.serverId, external.tool, outcome.content);
            externalManifests.push(outcome.manifest);
          } else if (event.call.name === "reply") {
            const threadId = args.threadId,
              body = args.body;
            if (typeof threadId === "string" && typeof body === "string") {
              const thread = selected.find((c) => c.threadId === threadId);
              if (thread && thread.author.kind === "human") {
                const replyParent =
                  typeof args.replyTo === "string"
                    ? selected.find((c) => c.commentId === args.replyTo && c.threadId === threadId)
                    : thread;
                const proposal = args.proposal;
                const proposalAllowed =
                  proposal === undefined ||
                  Array.isArray(proposal) ||
                  (typeof proposal === "object" &&
                    proposal !== null &&
                    !Array.isArray(proposal) &&
                    thread.anchor?.artifactId !== undefined &&
                    typeof Reflect.get(proposal, "elementId") === "string" &&
                    store
                      .elements(thread.anchor.artifactId)
                      .some((e) => e.elementId === Reflect.get(proposal, "elementId")));
                if (!replyParent || !proposalAllowed)
                  result = {
                    error: "Reply reference or proposal is outside the selected thread.",
                  };
                else {
                  const posted = await this.queue.run(() =>
                    this.available().transaction(() => {
                      if (!this.hasJobLease(job)) return { error: "Agent turn lease expired." };
                      const comment = this.feedback!.agentReply({
                        sessionId: turn.sessionId,
                        threadId,
                        turnId,
                        body,
                        replyTo: replyParent.commentId,
                        ...(proposal === undefined ? {} : { proposal }),
                      });
                      for (const c of selected.filter((x) => x.threadId === threadId))
                        this.available().saveFeedback(
                          "delivery-state",
                          c.commentId,
                          this.contract.read<Json>("delivery-state", {
                            commentId: c.commentId,
                            state: "replied",
                            turnId,
                            updatedAt: this.deps.clock.now(),
                          }),
                        );
                      return comment;
                    }),
                  );
                  result = posted;
                }
              } else
                result = {
                  error: "Reply thread is outside this turn context.",
                };
            }
          } else if (event.call.name === "read_elements" || event.call.name === "outline") {
            const artifactId = args.artifactId;
            const attached = store.feedbackList("attachment").some((x) => {
              const item = this.contract.read<{
                sessionId: string;
                artifactId: string;
              }>("session-artifact", x);
              return item.sessionId === turn.sessionId && item.artifactId === artifactId;
            });
            if (typeof artifactId === "string" && attached)
              result =
                event.call.name === "outline"
                  ? outline(store.elements(artifactId))
                  : store
                      .elements(artifactId, typeof args.version === "number" ? args.version : undefined)
                      .filter((e) => !Array.isArray(args.elementIds) || args.elementIds.includes(e.elementId));
            else result = { error: "Artifact is not attached to this session." };
          } else if (event.call.name === "search" && typeof args.query === "string") {
            result = store.search(turn.sessionId, args.query);
          } else if (event.call.name === "suggest_review") {
            const question = args.question,
              elementIds = args.elementIds;
            if (
              typeof question === "string" &&
              Array.isArray(elementIds) &&
              elementIds.every((id) => typeof id === "string")
            ) {
              const attachedIds = store
                .feedbackList("attachment")
                .map((x) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", x))
                .filter((x) => x.sessionId === turn.sessionId)
                .map((x) => x.artifactId);
              const valid = attachedIds.flatMap((artifactId) => store.elements(artifactId).map((e) => e.elementId));
              if (elementIds.every((id) => valid.includes(id))) {
                const draftId = this.deps.ids.next("review_draft_");
                const saved = await this.queue.run(() =>
                  store.transaction(() => {
                    if (!this.hasJobLease(job)) return false;
                    store.saveFeedback(
                      "review-draft",
                      draftId,
                      this.contract.read<Json>("json", {
                        draftId,
                        sessionId: turn.sessionId,
                        question,
                        elementIds,
                        createdByTurnId: turnId,
                        createdAt: this.deps.clock.now(),
                      }),
                    );
                    return true;
                  }),
                );
                result = saved ? { draftId, saved: true } : { error: "Agent turn lease expired." };
              } else
                result = {
                  error: "An element is outside the attached artifacts.",
                };
            }
          }
          toolResults.push({
            id: event.call.id,
            name: event.call.name,
            content: JSON.stringify(result),
          });
        }
      if (toolResults.length) {
        const calls = events
          .filter((event): event is Extract<GatewayEvent, { type: "tool_call" }> => event.type === "tool_call")
          .map((event) => event.call);
        const followMessages: GatewayRequest["messages"] = [
          ...messages,
          { role: "assistant", content: "", toolCalls: calls },
          ...toolResults.map((item) => ({
            role: "tool" as const,
            toolCallId: item.id,
            content: item.content,
          })),
        ];
        const followRequest: GatewayRequest = {
          modelRef,
          messages: followMessages,
          maxOutputTokens: 600,
        };
        if (estimateInputTokens(followRequest) + followRequest.maxOutputTokens > turnLimit)
          fail("budget_exceeded", "Reply tool context exceeds its configured token limit");
        const followItems = [
          ...manifest.items,
          ...externalManifests,
          ...toolResults.map((item) => ({
            kind: "tool_result" as const,
            id: item.id,
            hash: createHash("sha256").update(item.content).digest("hex"),
            tokens: Math.ceil(item.content.length / 3),
            reason: "tool result",
          })),
        ];
        const followManifest = this.contract.read<ContextManifest>("context-manifest", {
          manifestId: this.deps.ids.next("manifest_"),
          turnId,
          requestIndex: 1,
          items: followItems,
          dropped: [],
          promptHash,
          createdAt: this.deps.clock.now(),
        });
        await this.queue.run(() =>
          store.transaction(() =>
            store.saveFeedback("manifest", followManifest.manifestId, this.contract.read<Json>("json", followManifest)),
          ),
        );
        const followReservationId = this.deps.ids.next("reservation_");
        this.budgets?.reserve(
          followReservationId,
          [{ kind: "turn", key: turnId }, { kind: "session", key: turn.sessionId }, { kind: "daily" }],
          estimateReservationMicros(followRequest, model),
        );
        for await (const ignored of this.gateway!.call(followRequest, {
          reservationId: followReservationId,
          idempotencyKey: turnId + ":1",
          signal: abort.signal,
        }))
          void ignored;
      }
      const error = events.find((event): event is Extract<GatewayEvent, { type: "error" }> => event.type === "error");
      await this.queue.run(() =>
        this.available().transaction(() => {
          if (!this.hasJobLease(job)) return;
          const status: AgentTurn["status"] = error ? (error.code === "timeout" ? "uncertain" : "failed") : "completed";
          const current = this.contract.read<AgentTurn>("agent-turn", this.available().feedback("agent-turn", turnId));
          this.available().saveFeedback(
            "agent-turn",
            turnId,
            this.contract.read<Json>("json", {
              ...current,
              status,
              completedAt: this.deps.clock.now(),
              ...(error ? { errorCode: error.code } : {}),
            }),
          );
        }),
      );
    } catch (error) {
      const normalized = errorOf(error);
      await this.queue.run(() =>
        this.available().transaction(() => {
          if (!this.hasJobLease(job)) return;
          const current = this.contract.read<AgentTurn>("agent-turn", this.available().feedback("agent-turn", turnId));
          this.available().saveFeedback(
            "agent-turn",
            turnId,
            this.contract.read<Json>("json", {
              ...current,
              status: "uncertain",
              completedAt: this.deps.clock.now(),
              errorCode: normalized.code,
            }),
          );
        }),
      );
    }
  }

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
