import type {
  Json,
  AgentTurn,
  ContextManifest,
  FeedbackComment,
  Job,
  SessionDigest,
} from "../../../contract/src/index.js";
import { readFile } from "node:fs/promises";
import { errorOf, fail } from "../../../contract/src/index.js";
import { outline } from "../content/index.js";
import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import { createHash } from "node:crypto";
import type { ModelEvent as GatewayEvent, ModelRequest as GatewayRequest } from "../gateway/types.js";
import { replyToolNames, replyToolSchemas } from "./tools.js";
import { AgentExternalRuntime } from "./external-runtime.js";
import { untrustedMcpResult } from "./tools/external.js";
import { agentFor } from "../gateway/types.js";
import { sessionPreferences } from "../session-preferences.js";

export abstract class AgentRuntime extends AgentExternalRuntime {
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
          selected
            .map((c) => `${c.author.kind} [threadId=${c.threadId}; commentId=${c.commentId}]: ${c.body}`)
            .join("\n") +
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
      sessionPreferences(this.settings(), turn.sessionId).tokenLimit ??
      this.settings().budgets.defaultTurnTokenLimit ??
      8192;
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
              updatedAt: this.deps.clock.now(),
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
      [
        { kind: "turn", key: turnId },
        { kind: "session", key: turn.sessionId },
        { kind: "daily" },
        { kind: "agent", key: agentFor(modelRef) },
      ],
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
                updatedAt: this.deps.clock.now(),
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
        attribution: { agentId: agentFor(modelRef), sessionId: turn.sessionId, purpose: "reply" },
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
            (sessionPreferences(this.settings(), turn.sessionId).toolCallLimit ??
              this.settings().budgets.toolCallLimit ??
              12)
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
          [
            { kind: "turn", key: turnId },
            { kind: "session", key: turn.sessionId },
            { kind: "daily" },
            { kind: "agent", key: agentFor(modelRef) },
          ],
          estimateReservationMicros(followRequest, model),
        );
        for await (const ignored of this.gateway!.call(followRequest, {
          reservationId: followReservationId,
          attribution: { agentId: agentFor(modelRef), sessionId: turn.sessionId, purpose: "reply" },
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
              updatedAt: this.deps.clock.now(),
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
              updatedAt: this.deps.clock.now(),
              completedAt: this.deps.clock.now(),
              errorCode: normalized.code,
            }),
          );
        }),
      );
    }
  }
}
