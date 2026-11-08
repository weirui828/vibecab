import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fail } from "../../../contract/src/index.js";
import type {
  Json,
  ContextManifest,
  FeedbackComment,
  FeedbackConflict,
  Agreement,
  Update,
} from "../../../contract/src/index.js";
import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import type { ModelEvent as GatewayEvent, ModelRequest as GatewayRequest } from "../gateway/types.js";
import { UpdatePreparationRuntime } from "./preparation-runtime.js";
import { discussionFor, storeRequestIndex } from "./helpers.js";
import { untrustedMcpResult } from "../agent/index.js";
import { BUILT_IN_AGENT } from "../gateway/types.js";

/** What an Update's model call is for, by its prompt: planning, writing, or judging a conflict. */
const purposeOf = (promptName: string): "plan" | "update" | "review" =>
  promptName === "plan" ? "plan" : promptName === "judge" ? "review" : "update";
import { baseModelRef } from "../session-preferences.js";
import { sessionPreferences } from "../session-preferences.js";

export abstract class UpdatePlanningRuntime extends UpdatePreparationRuntime {
  protected async judgeUpdateConflicts(
    update: Update,
    agreements: Agreement[],
    comments: FeedbackComment[],
  ): Promise<{ agreements: Agreement[]; blocked: Update["itemResults"] }> {
    const store = this.available(),
      conflicts = store
        .feedbackList("conflict")
        .map((x) => this.contract.read<FeedbackConflict>("feedback-conflict", x))
        .filter(
          (x) =>
            x.state === "open" &&
            x.artifactId === update.artifactId &&
            x.itemIds.some((id) => update.itemIds.includes(id)),
        );
    const blocked: Update["itemResults"] = [],
      eligible = new Set(agreements.map((a) => a.agreementId)),
      alias = this.settings().models.judge ? "judge" : undefined;
    for (const conflict of conflicts) {
      const pair = conflict.itemIds
        .map((id) => agreements.find((a) => a.agreementId === id))
        .filter((x): x is Agreement => x !== undefined);
      if (pair.length < 2) continue;
      let verdict: "compatible" | "conflicting" | "unclear" = "unclear",
        reason = "No conflict judge model is configured.";
      if (alias) {
        const messages: GatewayRequest["messages"] = [
          {
            role: "user",
            content: JSON.stringify(
              pair.map((a) => ({
                instruction: a.instruction,
                comment: store.feedback("comment", a.commentId),
                discussion: discussionFor(comments, a.commentId),
              })),
            ),
          },
        ];
        const output = await this.modelJson(alias, "conflict-judgement", update, messages, "judge");
        if (output) {
          const judged = this.contract.read<import("../../../contract/src/index.js").ConflictJudgement>(
            "conflict-judgement",
            output,
          );
          verdict = judged.verdict;
          reason = judged.reason;
        }
      }
      if (verdict === "compatible")
        await this.queue.run(() =>
          store.transaction(() => {
            const current = this.contract.read<FeedbackConflict>(
              "feedback-conflict",
              store.feedback("conflict", conflict.conflictId),
            );
            store.saveFeedback(
              "conflict",
              conflict.conflictId,
              this.contract.read<Json>("feedback-conflict", {
                ...current,
                state: "resolved",
                judgement: { verdict, reason, judgedAt: this.deps.clock.now() },
              }),
            );
          }),
        );
      else
        for (const agreement of pair) {
          eligible.delete(agreement.agreementId);
          blocked.push({
            itemId: agreement.agreementId,
            status: "not_addressed",
            reason: `Conflict remains ${verdict}: ${reason}`,
          });
        }
    }
    return {
      agreements: agreements.filter((a) => eligible.has(a.agreementId)),
      blocked,
    };
  }

  protected async modelJson(
    alias: string,
    schemaName: string,
    update: Update,
    messages: GatewayRequest["messages"],
    promptName: string,
  ): Promise<Json | undefined> {
    const settings = this.settings(),
      model = this.gateway && settings.models[alias];
    if (!model || !this.gateway) return undefined;
    const prompt = await readFile(new URL(`../agent/prompts/${promptName}.md`, import.meta.url), "utf8"),
      promptHash = createHash("sha256").update(prompt).digest("hex");
    const sessionSettings = sessionPreferences(settings, this.updateSessionId(update)),
      tokenLimit = sessionSettings?.tokenLimit ?? settings.budgets.defaultTurnTokenLimit ?? 8192;
    const sessionId = this.updateSessionId(update),
      externalTools = this.externalToolRuntime(),
      offeredExternal = externalTools.offered(sessionId, "update"),
      externalByName = new Map(offeredExternal.map((tool) => [tool.name, tool])),
      previousToolCalls = this.available()
        .feedbackList("tool-call")
        .map((raw) => this.contract.read<import("../../../contract/src/index.js").ToolCall>("tool-call", raw))
        .filter((call) => call.turnId === update.updateId).length;
    const request: GatewayRequest = {
      modelRef: alias,
      messages: [{ role: "system", content: prompt }, ...messages],
      ...(offeredExternal.length
        ? {
            tools: offeredExternal.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
      output: {
        kind: "json",
        schema: this.contract.schema(schemaName),
        name: schemaName,
      },
      maxOutputTokens: Math.min(3000, tokenLimit),
    };
    if (estimateInputTokens(request) + request.maxOutputTokens > tokenLimit)
      fail("budget_exceeded", "Update context exceeds its configured token limit");
    const contextItems = messages.map((message, index) => ({
      kind: "retrieval" as const,
      id: `${schemaName}:${index}`,
      hash: createHash("sha256").update(message.content).digest("hex"),
      tokens: Math.ceil(message.content.length / 3),
      reason: `${message.role} context`,
    }));
    const manifestId = this.deps.ids.next("manifest_"),
      manifest = this.contract.read<ContextManifest>("context-manifest", {
        manifestId,
        turnId: update.updateId,
        requestIndex: storeRequestIndex(this.available(), update.updateId),
        items: [
          {
            kind: "system_prompt",
            id: `${promptName}.md`,
            hash: promptHash,
            tokens: Math.ceil(prompt.length / 3),
            reason: "Update prompt",
          },
          ...contextItems,
        ],
        dropped: [],
        promptHash,
        createdAt: this.deps.clock.now(),
      });
    await this.queue.run(() =>
      this.available().transaction(() =>
        this.available().saveFeedback("manifest", manifestId, this.contract.read<Json>("json", manifest)),
      ),
    );
    const reservationId = this.deps.ids.next("reservation_");
    this.budgets?.reserve(
      reservationId,
      [
        { kind: "turn", key: update.updateId },
        { kind: "session", key: this.updateSessionId(update) },
        { kind: "daily" },
        { kind: "agent", key: BUILT_IN_AGENT },
      ],
      estimateReservationMicros(request, model),
    );
    let output: Json | undefined;
    const events: GatewayEvent[] = [];
    for await (const event of this.gateway.call(request, {
      reservationId,
      attribution: { agentId: BUILT_IN_AGENT, sessionId: this.updateSessionId(update), purpose: purposeOf(promptName) },
      idempotencyKey: `${update.updateId}:${promptName}:${manifest.requestIndex}`,
      signal: new AbortController().signal,
    })) {
      events.push(event);
      if (event.type === "output") output = this.contract.read<Json>(schemaName, event.json);
      if (event.type === "error") fail(event.code === "rate_limited" ? "rate_limited" : "unavailable", event.message);
    }
    const calls = events.filter(
      (event): event is Extract<GatewayEvent, { type: "tool_call" }> => event.type === "tool_call",
    );
    if (calls.length) {
      const limit = sessionPreferences(settings, sessionId).toolCallLimit ?? settings.budgets.toolCallLimit ?? 12,
        toolResults: Array<{ id: string; name: string; content: string }> = [],
        manifestItems: ContextManifest["items"] = [];
      for (const [index, event] of calls.entries()) {
        const offered = externalByName.get(event.call.name);
        if (!offered || previousToolCalls + index >= limit) {
          toolResults.push({
            id: event.call.id,
            name: event.call.name,
            content: "External tool is not allowed in this Update.",
          });
          continue;
        }
        const outcome = await externalTools.call(
          update.updateId,
          sessionId,
          "update",
          offered,
          event.call.arguments,
          settings.budgets.toolTimeoutMs ?? 20_000,
          settings.budgets.toolResultByteLimit ?? 32_768,
        );
        toolResults.push({
          id: event.call.id,
          name: event.call.name,
          content: untrustedMcpResult(offered.serverId, offered.tool, outcome.content),
        });
        manifestItems.push(outcome.manifest);
      }
      const followRequest: GatewayRequest = {
        modelRef: alias,
        messages: [
          ...request.messages,
          { role: "assistant", content: "", toolCalls: calls.map((event) => event.call) },
          ...toolResults.map((tool) => ({ role: "tool" as const, toolCallId: tool.id, content: tool.content })),
        ],
        output: request.output,
        maxOutputTokens: request.maxOutputTokens,
      };
      if (estimateInputTokens(followRequest) + followRequest.maxOutputTokens > tokenLimit)
        fail("budget_exceeded", "Update tool context exceeds its configured token limit");
      const followManifestId = this.deps.ids.next("manifest_"),
        followManifest = this.contract.read<ContextManifest>("context-manifest", {
          manifestId: followManifestId,
          turnId: update.updateId,
          requestIndex: manifest.requestIndex + 1,
          items: [...manifest.items, ...manifestItems],
          dropped: [],
          promptHash,
          createdAt: this.deps.clock.now(),
        });
      await this.queue.run(() =>
        this.available().transaction(() =>
          this.available().saveFeedback("manifest", followManifestId, this.contract.read<Json>("json", followManifest)),
        ),
      );
      const followReservationId = this.deps.ids.next("reservation_");
      this.budgets?.reserve(
        followReservationId,
        [
          { kind: "turn", key: update.updateId },
          { kind: "session", key: sessionId },
          { kind: "daily" },
          { kind: "agent", key: BUILT_IN_AGENT },
        ],
        estimateReservationMicros(followRequest, model),
      );
      for await (const event of this.gateway.call(followRequest, {
        reservationId: followReservationId,
        attribution: { agentId: BUILT_IN_AGENT, sessionId, purpose: purposeOf(promptName) },
        idempotencyKey: `${update.updateId}:${promptName}:${followManifest.requestIndex}`,
        signal: new AbortController().signal,
      })) {
        if (event.type === "output") output = this.contract.read<Json>(schemaName, event.json);
        if (event.type === "error") fail(event.code === "rate_limited" ? "rate_limited" : "unavailable", event.message);
      }
    }
    return output;
  }

  protected updateSessionId(update: Update): string {
    const store = this.available();
    for (const id of update.itemIds) {
      const raw = store.feedback("agreement", id);
      if (raw) {
        const agreement = this.contract.read<Agreement>("agreement", raw),
          comment = store.feedback("comment", agreement.commentId);
        if (comment) return this.contract.read<FeedbackComment>("feedback-comment", comment).sessionId;
      }
    }
    fail("not_found", "Update has no session context");
  }

  protected async planUpdate(
    update: Update,
    items: Agreement[],
    comments: FeedbackComment[],
    elements: import("../../../contract/src/index.js").Element[],
    alreadyChanged: import("../../../contract/src/index.js").CommitInput["changes"],
  ): Promise<import("../../../contract/src/index.js").UpdatePlan | undefined> {
    const already = new Set(alreadyChanged.flatMap((c) => (c.op === "add" ? [] : [c.elementId])));
    for (const raw of this.available().feedbackList("hold"))
      if (this.activeHold(raw)) {
        const hold = this.contract.read<{
          artifactId: string;
          elementId: string;
        }>("hold", raw);
        if (hold.artifactId === update.artifactId) already.add(hold.elementId);
      }
    const known = new Set(elements.map((e) => e.elementId));
    const messages: GatewayRequest["messages"] = [
      {
        role: "user",
        content: JSON.stringify({
          items: items.map((a) => ({
            itemId: a.agreementId,
            instruction: a.instruction,
            comment: comments.find((c) => c.commentId === a.commentId),
            discussion: discussionFor(comments, a.commentId),
          })),
          elements,
        }),
      },
    ];
    const alias = this.settings().models.planner
      ? "planner"
      : baseModelRef(this.settings(), this.updateSessionId(update));
    const output = await this.modelJson(alias, "update-plan", update, messages, "plan");
    if (output === undefined) return undefined;
    const plan = this.contract.read<import("../../../contract/src/index.js").UpdatePlan>("update-plan", output),
      expected = new Set(items.map((x) => x.agreementId));
    if (
      plan.items.length !== expected.size ||
      new Set(plan.items.map((x) => x.itemId)).size !== expected.size ||
      plan.items.some((x) => !expected.has(x.itemId))
    )
      fail("invalid", "Planner did not account for every Update item");
    for (const item of plan.items) {
      if (
        item.elementIds.some((id) => !known.has(id) || already.has(id)) ||
        item.newUnder?.some((id) => !known.has(id) || already.has(id))
      )
        fail("invalid", "Planner referenced an unknown, held, or already changed element");
      if (item.action === "none" && (item.elementIds.length || item.newUnder?.length))
        fail("invalid", "A no-op plan cannot declare a write set");
      if (item.action === "add" && !item.newUnder?.length) fail("invalid", "An add plan must name a permitted parent");
      if (["edit", "move", "remove"].includes(item.action) && !item.elementIds.length)
        fail("invalid", "A modifying plan must name existing elements");
    }
    return plan;
  }
}
