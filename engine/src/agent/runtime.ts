import { readFile } from "node:fs/promises";

import { fail } from "../../../contract/src/index.js";
import type { Json, AgentTurn, ContextManifest, FeedbackComment, Job } from "../../../contract/src/index.js";

import { outline } from "../content/diff.js";

import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import { createHash } from "node:crypto";
import type { ModelEvent as GatewayEvent, ModelRequest as GatewayRequest } from "../gateway/types.js";

import { EngineCore } from "../kernel/engine-core.js";
import { replyToolNames, replyToolSchemas } from "./tools.js";

export abstract class AgentRuntime extends EngineCore {
  protected askAgent(raw: unknown): { turnId: string } {
    const store = this.available(),
      p = this.contract.read<{ sessionId: string; threadIds?: string[] }>(
        "operations/vc.AskAgent",
        raw,
        "#/properties/payload",
      );
    const session = store.feedback("session", p.sessionId);
    if (!session) fail("not_found", "Session not found");
    const sessionRecord = this.contract.read<Record<string, Json>>("session", session);
    if (sessionRecord.state !== "active") fail("conflict", "Agent replies require an active session");
    const all = store.feedbackList("comment").map((x) => this.contract.read<FeedbackComment>("feedback-comment", x));
    const selected = all.filter(
      (c) =>
        c.sessionId === p.sessionId &&
        !c.deleted &&
        c.author.kind === "human" &&
        (p.threadIds === undefined || p.threadIds.includes(c.threadId)),
    );
    if (!selected.length) fail("not_found", "No human comments match the requested threads");
    return this.queueReplyTurn(p.sessionId, selected, "manual", p.threadIds);
  }

  protected hasJobLease(job: Job): boolean {
    const current = this.available()
      .jobs()
      .find((candidate) => candidate.id === job.id);
    return current?.state === "leased" && current.attempts === job.attempts;
  }

  protected queueReplyTurn(
    sessionId: string,
    selected: FeedbackComment[],
    mode: "manual" | "realtime" | "batch",
    threadIds?: string[],
  ): { turnId: string } {
    const store = this.available(),
      turnId = this.deps.ids.next("turn_"),
      settings = this.settings(),
      modelRef = settings.models.reply ? "reply" : "default";
    const turn = this.contract.read<AgentTurn>("agent-turn", {
      turnId,
      sessionId,
      kind: "reply",
      trigger: {
        mode,
        commentIds: selected.map((c) => c.commentId),
        ...(threadIds ? { threadIds } : {}),
      },
      manifestId: this.deps.ids.next("manifest_"),
      status: "queued",
      createdAt: this.deps.clock.now(),
    });
    store.saveFeedback("agent-turn", turnId, this.contract.read<Json>("json", turn));
    for (const c of selected)
      store.saveFeedback(
        "delivery-state",
        c.commentId,
        this.contract.read<Json>("delivery-state", {
          commentId: c.commentId,
          state: "queued",
          turnId,
          updatedAt: this.deps.clock.now(),
        }),
      );
    store.enqueue("agent.reply", turnId, this.contract.read<Json>("json", { turnId, modelRef }), this.deps.clock.now());
    return { turnId };
  }

  protected async runTrigger(job: Job): Promise<void> {
    const payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const sessionId = Reflect.get(payload, "sessionId"),
      mode = Reflect.get(payload, "mode");
    if (typeof sessionId !== "string" || (mode !== "realtime" && mode !== "batch")) return;
    await this.queue.run(() =>
      this.available().transaction(() => {
        const store = this.available(),
          active = store
            .feedbackList("agent-turn")
            .map((x) => this.contract.read<AgentTurn>("agent-turn", x))
            .some((t) => t.sessionId === sessionId && ["queued", "running"].includes(t.status));
        const comments = store
          .feedbackList("comment")
          .map((x) => this.contract.read<FeedbackComment>("feedback-comment", x))
          .filter(
            (c) =>
              c.sessionId === sessionId &&
              c.author.kind === "human" &&
              !c.deleted &&
              this.contract.read<{
                commentId: string;
                state: string;
                updatedAt: string;
              }>(
                "delivery-state",
                store.feedback("delivery-state", c.commentId) ?? {
                  commentId: c.commentId,
                  state: "saved",
                  updatedAt: c.createdAt,
                },
              ).state === "saved",
          );
        if (!comments.length) return;
        if (active) {
          store.enqueue(
            "agent.trigger",
            this.deps.ids.next("trigger_"),
            this.contract.read<Json>("json", {
              sessionId,
              mode,
              notBefore: new Date(Date.parse(this.deps.clock.now()) + 1000).toISOString(),
            }),
            this.deps.clock.now(),
          );
          return;
        }
        const now = Date.parse(this.deps.clock.now()),
          prefs = this.settings().sessions[sessionId] ?? {},
          latest = Math.max(...comments.map((c) => Date.parse(c.createdAt)));
        let effectiveMode: "realtime" | "batch" = mode;
        const recentTurns = store
          .feedbackList("agent-turn")
          .map((x) => this.contract.read<AgentTurn>("agent-turn", x))
          .filter(
            (t) =>
              t.sessionId === sessionId && t.trigger.mode === "realtime" && now - Date.parse(t.createdAt) < 3_600_000,
          ).length;
        const rateLimit = prefs.replyRateLimitPerHour ?? 20;
        if (mode === "realtime" && recentTurns >= rateLimit) {
          effectiveMode = "batch";
          this.feedback?.systemNotice(
            sessionId,
            comments[0]!.threadId,
            "Realtime replies reached the session rate limit. New comments will be handled in batch mode.",
          );
        }
        if (
          effectiveMode === "realtime" &&
          now < latest + (prefs.realtimeDebounceSeconds ?? this.settings().budgets.realtimeDebounceSeconds ?? 8) * 1000
        )
          return;
        if (
          effectiveMode === "batch" &&
          comments.length < (prefs.batchCommentThreshold ?? 5) &&
          now < latest + (prefs.batchIdleMinutes ?? 10) * 60_000
        )
          return;
        this.queueReplyTurn(sessionId, comments, effectiveMode);
      }),
    );
  }

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
    const prompt = await readFile(new URL("./prompts/reply.md", import.meta.url), "utf8");
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const messages: GatewayRequest["messages"] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content:
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
      ],
      dropped: [],
      promptHash,
      createdAt: this.deps.clock.now(),
    });
    await this.queue.run(() =>
      store.transaction(() => store.saveFeedback("manifest", manifestId, this.contract.read<Json>("json", manifest))),
    );
    const toolNames = replyToolNames;
    const schemas = replyToolSchemas(this.contract);
    const turnLimit =
      this.settings().sessions[turn.sessionId]?.tokenLimit ?? this.settings().budgets.defaultTurnTokenLimit ?? 8192;
    const request: GatewayRequest = {
      modelRef,
      messages,
      tools: toolNames.map((name) => ({
        name,
        description: name.replaceAll("_", " "),
        parameters: schemas.get(name)!,
      })),
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
          const schema = schemas.get(event.call.name);
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
          if (event.call.name === "reply") {
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
    } catch {
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
            }),
          );
        }),
      );
    }
  }
}
