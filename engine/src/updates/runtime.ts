import { readFile } from "node:fs/promises";

import { errorOf, fail } from "../../../contract/src/index.js";
import type {
  Json,
  ContextManifest,
  FeedbackComment,
  FeedbackConflict,
  Agreement,
  Update,
  Job,
} from "../../../contract/src/index.js";

import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import { createHash } from "node:crypto";
import type { ModelRequest as GatewayRequest } from "../gateway/types.js";

import { AgentRuntime } from "../agent/runtime.js";

export abstract class UpdateRuntime extends AgentRuntime {
  protected directEditingEnabled(artifactId: string): boolean {
    return this.available()
      .feedbackList("attachment")
      .map((x) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", x))
      .some(
        (link) => link.artifactId === artifactId && this.settings().sessions[link.sessionId]?.directEditing === true,
      );
  }

  protected activeHold(raw: unknown): boolean {
    const hold = this.contract.read<{
      heldAt: string;
      lastActivity: string;
      releasedAt?: string;
    }>("hold", raw);
    if (hold.releasedAt) return false;
    const artifactId =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Reflect.get(raw, "artifactId") : undefined;
    const attached =
      typeof artifactId === "string"
        ? this.available()
            .feedbackList("attachment")
            .map((x) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", x))
            .filter((x) => x.artifactId === artifactId)
        : [];
    const timeout =
      attached
        .map((x) => this.settings().sessions[x.sessionId]?.holdIdleMinutes)
        .find((value): value is number => value !== undefined) ?? 30;
    return Date.parse(this.deps.clock.now()) - Date.parse(hold.lastActivity) < timeout * 60_000;
  }

  protected activeUpdateTouches(artifactId: string, elementId: string): boolean {
    const store = this.available();
    for (const raw of store.feedbackList("update")) {
      const update = this.contract.read<Update>("update", raw);
      if (
        update.artifactId !== artifactId ||
        !["queued", "planning", "awaiting_plan_review", "writing", "checking"].includes(update.status)
      )
        continue;
      if (update.plan) {
        const plan = this.contract.read<import("../../../contract/src/index.js").UpdatePlan>(
          "update-plan",
          update.plan,
        );
        if (plan.items.some((item) => item.elementIds.includes(elementId) || item.newUnder?.includes(elementId)))
          return true;
      }
    }
    return false;
  }

  protected async runUpdateTrigger(job: Job): Promise<void> {
    const payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const artifactId = Reflect.get(payload, "artifactId");
    if (typeof artifactId !== "string") return;
    await this.queue.run(() =>
      this.available().transaction(() => {
        try {
          this.startUpdate({ artifactId });
        } catch (error) {
          if (errorOf(error).code !== "not_found" && errorOf(error).code !== "locked") throw error;
        }
      }),
    );
  }

  protected startUpdate(raw: unknown): { updateId: string; status: string } {
    const store = this.available(),
      p = this.contract.read<{ artifactId: string }>("operations/vc.StartUpdate", raw, "#/properties/payload"),
      artifact = store.artifact(p.artifactId);
    const existing = store
      .feedbackList("update")
      .map((x) => this.contract.read<Update>("update", x))
      .find(
        (x) =>
          x.artifactId === p.artifactId &&
          ["queued", "planning", "awaiting_plan_review", "writing", "checking"].includes(x.status),
      );
    if (existing) fail("locked", "An Update is already active for this artifact");
    const agreements = store
      .feedbackList("agreement")
      .map((x) => this.contract.read<Agreement>("agreement", x))
      .filter(
        (a) =>
          a.state === "agreed" &&
          store.feedback("comment", a.commentId) !== undefined &&
          this.contract.read<FeedbackComment>("feedback-comment", store.feedback("comment", a.commentId)).anchor
            ?.artifactId === p.artifactId,
      );
    if (!agreements.length) fail("not_found", "No agreed items target this artifact");
    const updateId = this.deps.ids.next("update_"),
      update = this.contract.read<Update>("update", {
        updateId,
        artifactId: p.artifactId,
        baseVersion: artifact.headVersion,
        itemIds: agreements.map((a) => a.agreementId),
        onBehalfOf: agreements.map((a) => ({ itemId: a.agreementId, kind: "human" as const })),
        status: "queued",
        itemResults: [],
        createdAt: this.deps.clock.now(),
      });
    store.saveFeedback("update", updateId, this.contract.read<Json>("json", update));
    for (const agreement of agreements)
      store.saveFeedback(
        "agreement",
        agreement.agreementId,
        this.contract.read<Json>("json", { ...agreement, state: "scheduled" }),
      );
    store.enqueue("agent.update", updateId, this.contract.read<Json>("json", { updateId }), this.deps.clock.now());
    return { updateId, status: "queued" };
  }

  protected cancelUpdate(raw: unknown): { updateId: string; status: string } {
    const p = this.contract.read<{ updateId: string }>("operations/vc.CancelUpdate", raw, "#/properties/payload"),
      store = this.available(),
      found = store.feedback("update", p.updateId);
    if (!found) fail("not_found", "Update not found");
    const update = this.contract.read<Update>("update", found);
    if (!["queued", "planning", "awaiting_plan_review", "writing", "checking"].includes(update.status))
      fail("conflict", "Update can no longer be cancelled");
    for (const itemId of update.itemIds) {
      const rawAgreement = store.feedback("agreement", itemId);
      if (rawAgreement) {
        const agreement = this.contract.read<Agreement>("agreement", rawAgreement);
        store.saveFeedback("agreement", itemId, this.contract.read<Json>("json", { ...agreement, state: "agreed" }));
      }
    }
    store.saveFeedback("update", p.updateId, this.contract.read<Json>("json", { ...update, status: "cancelled" }));
    return { updateId: p.updateId, status: "cancelled" };
  }

  protected approvePlan(raw: unknown, commandId: string): { updateId: string; status: string } {
    const p = this.contract.read<{ updateId: string }>("operations/vc.ApprovePlan", raw, "#/properties/payload"),
      store = this.available(),
      found = store.feedback("update", p.updateId);
    if (!found) fail("not_found", "Update not found");
    const update = this.contract.read<Update>("update", found);
    if (update.status !== "awaiting_plan_review" || !update.plan)
      fail("conflict", "Update is not waiting for plan review");
    store.saveFeedback("update", p.updateId, this.contract.read<Json>("json", { ...update, status: "writing" }));
    store.enqueue(
      "agent.update",
      this.deps.ids.next("update_job_"),
      this.contract.read<Json>("json", {
        updateId: p.updateId,
        approvedBy: commandId,
      }),
      this.deps.clock.now(),
    );
    return { updateId: p.updateId, status: "writing" };
  }

  protected async runUpdate(job: Job): Promise<void> {
    const payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const updateId = Reflect.get(payload, "updateId");
    if (typeof updateId !== "string") return;
    const store = this.available(),
      content = this.content;
    if (!content) return;
    let update = this.contract.read<Update>("update", store.feedback("update", updateId));
    if (update.status === "cancelled" || ["committed", "partially_committed", "failed"].includes(update.status)) return;
    await this.queue.run(() =>
      store.transaction(() => {
        const current = this.contract.read<Update>("update", store.feedback("update", updateId));
        if (current.status === "queued")
          store.saveFeedback(
            "update",
            updateId,
            this.contract.read<Json>("json", {
              ...current,
              status: "planning",
            }),
          );
      }),
    );
    update = this.contract.read<Update>("update", store.feedback("update", updateId));
    const allAgreements = update.itemIds
      .map((id) => store.feedback("agreement", id))
      .filter((x): x is Json => x !== undefined)
      .map((x) => this.contract.read<Agreement>("agreement", x));
    const { agreements, blocked } = await this.judgeUpdateConflicts(update, allAgreements);
    const comments = allAgreements.map((a) =>
      this.contract.read<FeedbackComment>("feedback-comment", store.feedback("comment", a.commentId)),
    );
    const elements = store.elements(update.artifactId, update.baseVersion),
      direct: import("../../../contract/src/index.js").CommitInput["changes"] = [],
      results: Update["itemResults"] = [...blocked],
      remaining: Agreement[] = [];
    for (const agreement of agreements) {
      const comment = comments.find((c) => c.commentId === agreement.commentId)!,
        anchor = comment.anchor,
        element = anchor ? elements.find((e) => e.elementId === anchor.elementId) : undefined,
        quote = anchor?.locator?.quote,
        replacement = comment.suggestion?.replacement;
      if (anchor) {
        const rawHold = store.feedback("hold", `${update.artifactId}:${anchor.elementId}`);
        if (rawHold && this.activeHold(rawHold)) {
          results.push({
            itemId: agreement.agreementId,
            status: "not_addressed",
            reason: "Element is held for direct editing.",
          });
          continue;
        }
      }
      if (!element || !("text" in element) || !quote || replacement === undefined) {
        remaining.push(agreement);
        continue;
      }
      const existingIndex = direct.findIndex(
          (change) => change.op === "update" && change.elementId === element.elementId,
        ),
        prior = existingIndex < 0 ? undefined : direct[existingIndex],
        currentText = prior?.op === "update" && "text" in prior.element ? prior.element.text : element.text;
      const at = findVerbatimQuote(currentText, quote, anchor.locator?.prefix, anchor.locator?.suffix);
      if (at === undefined) {
        remaining.push(agreement);
        continue;
      }
      const draft = this.contract.read<import("../../../contract/src/index.js").ElementDraft>("element-draft", {
        type: element.type,
        props: element.props,
        text: currentText.slice(0, at) + replacement + currentText.slice(at + quote.length),
      });
      if (existingIndex < 0)
        direct.push({
          op: "update",
          elementId: element.elementId,
          element: draft,
        });
      else
        direct[existingIndex] = {
          op: "update",
          elementId: element.elementId,
          element: draft,
        };
      results.push({
        itemId: agreement.agreementId,
        status: "addressed",
        elementIds: [element.elementId],
      });
    }
    try {
      if (remaining.length) {
        const planned =
          update.plan && update.status === "writing"
            ? this.contract.read<import("../../../contract/src/index.js").UpdatePlan>("update-plan", update.plan)
            : await this.planUpdate(update, remaining, comments, elements, direct);
        if (!planned) {
          await this.finishUpdate(
            update,
            allAgreements,
            [
              ...results,
              ...remaining.map((a) => ({
                itemId: a.agreementId,
                status: "not_addressed" as const,
                reason: "No planner model is configured.",
              })),
            ],
            direct,
            direct.length ? update.baseVersion + 1 : undefined,
          );
          return;
        }
        if (!update.plan) {
          const sessions = store
            .feedbackList("attachment")
            .map((x) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", x))
            .filter((x) => x.artifactId === update.artifactId)
            .map((x) => x.sessionId);
          const review = sessions.some((id) => this.settings().sessions[id]?.planReview === true);
          if (review) {
            await this.queue.run(() =>
              store.transaction(() => {
                const current = this.contract.read<Update>("update", store.feedback("update", updateId));
                if (current.status !== "planning") return;
                store.saveFeedback(
                  "update",
                  updateId,
                  this.contract.read<Json>("json", {
                    ...current,
                    plan: planned,
                    status: "awaiting_plan_review",
                    itemResults: results,
                  }),
                );
              }),
            );
            return;
          }
        }
        update = this.contract.read<Update>("update", store.feedback("update", updateId));
        await this.runUpdateWriter(update, remaining, allAgreements, comments, elements, direct, results, planned);
      } else
        await this.finishUpdate(
          update,
          allAgreements,
          results,
          direct,
          direct.length ? update.baseVersion + 1 : undefined,
        );
    } catch (error) {
      const reason = errorOf(error).message;
      await this.finishUpdate(
        update,
        allAgreements,
        [
          ...results,
          ...remaining.map((a) => ({
            itemId: a.agreementId,
            status: "not_addressed" as const,
            reason,
          })),
        ],
        direct,
        direct.length ? update.baseVersion + 1 : undefined,
      );
    }
  }

  protected async judgeUpdateConflicts(
    update: Update,
    agreements: Agreement[],
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
    const sessionSettings = settings.sessions[this.updateSessionId(update)],
      tokenLimit = sessionSettings?.tokenLimit ?? settings.budgets.defaultTurnTokenLimit ?? 8192;
    const request: GatewayRequest = {
      modelRef: alias,
      messages: [{ role: "system", content: prompt }, ...messages],
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
      ],
      estimateReservationMicros(request, model),
    );
    let output: Json | undefined;
    for await (const event of this.gateway.call(request, {
      reservationId,
      idempotencyKey: `${update.updateId}:${promptName}:${manifest.requestIndex}`,
      signal: new AbortController().signal,
    })) {
      if (event.type === "output") output = this.contract.read<Json>(schemaName, event.json);
      if (event.type === "error") fail(event.code === "rate_limited" ? "rate_limited" : "unavailable", event.message);
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
          })),
          elements,
        }),
      },
    ];
    const alias = this.settings().models.planner ? "planner" : "default";
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

  protected async runUpdateWriter(
    update: Update,
    remaining: Agreement[],
    agreements: Agreement[],
    comments: FeedbackComment[],
    elements: import("../../../contract/src/index.js").Element[],
    direct: import("../../../contract/src/index.js").CommitInput["changes"],
    directResults: Update["itemResults"],
    providedPlan?: import("../../../contract/src/index.js").UpdatePlan,
  ): Promise<void> {
    const plan =
      providedPlan ??
      (update.plan
        ? this.contract.read<import("../../../contract/src/index.js").UpdatePlan>("update-plan", update.plan)
        : undefined);
    if (!plan) fail("invalid", "Update plan is missing");
    if (update.status !== "writing") {
      await this.queue.run(() =>
        this.available().transaction(() => {
          const current = this.contract.read<Update>("update", this.available().feedback("update", update.updateId));
          if (current.status === "planning")
            this.available().saveFeedback(
              "update",
              update.updateId,
              this.contract.read<Json>("json", { ...current, status: "writing" }),
            );
        }),
      );
      update = this.contract.read<Update>("update", this.available().feedback("update", update.updateId));
    }
    const aliases = this.settings().models,
      alias = aliases.writer ? "writer" : "default",
      expected = new Set(remaining.map((x) => x.agreementId));
    const planned = new Set(plan.items.flatMap((item) => item.elementIds)),
      newUnder = new Set(plan.items.flatMap((item) => item.newUnder ?? []));
    const requestMessages: GatewayRequest["messages"] = [
      {
        role: "user",
        content: JSON.stringify({
          items: remaining.map((a) => ({
            itemId: a.agreementId,
            instruction: a.instruction,
            comment: comments.find((c) => c.commentId === a.commentId),
          })),
          plan,
          elements,
        }),
      },
    ];
    let write: import("../../../contract/src/index.js").UpdateWrite | undefined,
      validationError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await this.modelJson(
        alias,
        "update-write",
        update,
        [
          ...requestMessages,
          ...(validationError
            ? [
                {
                  role: "user" as const,
                  content: `Previous output rejected: ${validationError}`,
                },
              ]
            : []),
        ],
        "write",
      );
      if (output === undefined) break;
      try {
        const candidate = this.contract.read<import("../../../contract/src/index.js").UpdateWrite>(
            "update-write",
            output,
          ),
          changes = candidate.changes,
          changedIds = new Set<string>();
        for (const change of changes) {
          if (change.op === "add") {
            if (change.parentId !== null && !newUnder.has(change.parentId))
              fail("invalid", "Writer added outside the permitted new-child scope");
            if (!plan.items.some((item) => item.action === "add" && item.newUnder?.includes(change.parentId ?? "")))
              fail("invalid", "Writer added without a matching add plan");
            if (changedIds.has(change.tempId)) fail("invalid", "Writer reused a temporary id");
            changedIds.add(change.tempId);
          } else {
            if (!planned.has(change.elementId)) fail("invalid", "Writer changed outside the planned write set");
            const permitted = plan.items.some(
              (item) =>
                item.elementIds.includes(change.elementId) &&
                (change.op === "update"
                  ? item.action === "edit"
                  : change.op === "move"
                    ? item.action === "move"
                    : item.action === "remove"),
            );
            if (!permitted) fail("invalid", "Writer action does not match the reviewed plan");
            if (changedIds.has(change.elementId)) fail("invalid", "Writer changed an element more than once");
            changedIds.add(change.elementId);
          }
        }
        if (
          candidate.itemResults.length !== expected.size ||
          new Set(candidate.itemResults.map((x) => x.itemId)).size !== expected.size ||
          candidate.itemResults.some((x) => !expected.has(x.itemId))
        )
          fail("invalid", "Writer did not account for every agreed item");
        for (const result of candidate.itemResults)
          if (result.status === "addressed" && result.elementIds.some((id) => !changedIds.has(id)))
            fail("invalid", "Writer marked an unchanged element as addressed");
        write = candidate;
        break;
      } catch (error) {
        validationError = errorOf(error).message;
      }
    }
    const modelResults =
      write?.itemResults ??
      remaining.map((a) => ({
        itemId: a.agreementId,
        status: "not_addressed" as const,
        reason: validationError || "Writer did not return a valid result.",
      }));
    await this.queue.run(() =>
      this.available().transaction(() => {
        const current = this.contract.read<Update>("update", this.available().feedback("update", update.updateId));
        if (current.status === "writing")
          this.available().saveFeedback(
            "update",
            update.updateId,
            this.contract.read<Json>("json", { ...current, status: "checking" }),
          );
      }),
    );
    // Tests can stop deterministically after validation has been persisted and before the commit transaction.
    await this.deps.updateCheckpoint?.(update.updateId, "checking");
    await this.finishUpdate(
      update,
      agreements,
      [...directResults, ...modelResults],
      write ? [...direct, ...write.changes] : direct,
      write && [...direct, ...write.changes].length ? update.baseVersion + 1 : undefined,
    );
  }

  protected async finishUpdate(
    update: Update,
    agreements: Agreement[],
    results: Update["itemResults"],
    changes: import("../../../contract/src/index.js").CommitInput["changes"],
    expectedVersion?: number,
  ): Promise<void> {
    await this.queue.run(() =>
      this.available().transaction(() => {
        const store = this.available(),
          content = this.content;
        if (!content) fail("unavailable", "Content engine is stopped");
        const current = this.contract.read<Update>("update", store.feedback("update", update.updateId));
        if (!["queued", "planning", "writing", "checking"].includes(current.status)) return;
        let resultVersion: number | undefined,
          idMap: Record<string, string> = {};
        const base = store.version(update.artifactId, update.baseVersion),
          head = store.version(update.artifactId),
          staleIds = new Set<string>(),
          staleTemps = new Set<string>();
        const baseElements = store.elements(update.artifactId, update.baseVersion),
          children = new Map<string, string[]>();
        for (const element of baseElements)
          if (element.parentId) {
            const ids = children.get(element.parentId) ?? [];
            ids.push(element.elementId);
            children.set(element.parentId, ids);
          }
        const descendants = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(descendants)];
        const safeChanges = changes.filter((change) => {
          if (change.op === "add") {
            if (change.parentId !== null && !head.manifest[change.parentId]) {
              staleTemps.add(change.tempId);
              return false;
            }
            return true;
          }
          const targets = change.op === "remove" ? descendants(change.elementId) : [change.elementId],
            stale = targets.filter((id) => head.manifest[id] !== base.manifest[id]);
          if (stale.length) {
            for (const id of stale) staleIds.add(id);
            staleIds.add(change.elementId);
            return false;
          }
          return true;
        });
        if (safeChanges.length) {
          const committed = content.commit({
            artifactId: update.artifactId,
            baseVersion: update.baseVersion,
            changes: safeChanges,
            createdBy: { kind: "agent", turnId: update.updateId },
            source: { updateId: update.updateId },
          });
          resultVersion = committed.version;
          idMap = committed.idMap;
          if (expectedVersion !== undefined && resultVersion < expectedVersion)
            fail("internal", "Update committed before its expected version");
        }
        const normalized = results.map((result) =>
          result.status === "addressed" && result.elementIds
            ? (() => {
                const stale = result.elementIds.some((id) => staleIds.has(id) || staleTemps.has(id));
                return stale
                  ? {
                      itemId: result.itemId,
                      status: "not_addressed" as const,
                      reason: "A direct edit changed part of this item while the Update was running.",
                    }
                  : {
                      ...result,
                      elementIds: result.elementIds.map((id) => idMap[id] ?? id),
                    };
              })()
            : result,
        );
        for (const agreement of agreements) {
          const result = normalized.find((x) => x.itemId === agreement.agreementId);
          if (result?.status === "addressed" && resultVersion) {
            store.saveFeedback(
              "agreement",
              agreement.agreementId,
              this.contract.read<Json>("agreement", {
                ...agreement,
                state: "applied",
                appliedVersion: resultVersion,
              }),
            );
            const raw = store.feedback("comment", agreement.commentId);
            if (raw) {
              const comment = this.contract.read<FeedbackComment>("feedback-comment", raw);
              store.saveFeedback(
                "comment",
                comment.commentId,
                this.contract.read<Json>("feedback-comment", {
                  ...comment,
                  state: "applied",
                  appliedInVersion: resultVersion,
                  updatedAt: this.deps.clock.now(),
                }),
              );
              store.saveFeedback(
                "delivery-state",
                comment.commentId,
                this.contract.read<Json>("delivery-state", {
                  commentId: comment.commentId,
                  state: "handled",
                  updatedAt: this.deps.clock.now(),
                }),
              );
              this.feedback?.systemNotice(
                comment.sessionId,
                comment.threadId,
                `Agreed item applied in version ${resultVersion}.`,
              );
            }
          } else
            store.saveFeedback(
              "agreement",
              agreement.agreementId,
              this.contract.read<Json>("agreement", {
                ...agreement,
                state: "agreed",
              }),
            );
        }
        const status: Update["status"] = resultVersion
          ? normalized.some((x) => x.status === "not_addressed")
            ? "partially_committed"
            : "committed"
          : "failed";
        store.saveFeedback(
          "update",
          update.updateId,
          this.contract.read<Json>("json", {
            ...current,
            status,
            ...(resultVersion ? { resultVersion } : {}),
            itemResults: normalized,
          }),
        );
      }),
    );
  }
}

function findVerbatimQuote(text: string, quote: string, prefix?: string, suffix?: string): number | undefined {
  const positions: number[] = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) positions.push(at);
  if (prefix !== undefined || suffix !== undefined) {
    const contextual = positions.filter(
      (at) =>
        (prefix === undefined || text.slice(Math.max(0, at - prefix.length), at) === prefix) &&
        (suffix === undefined || text.slice(at + quote.length, at + quote.length + suffix.length) === suffix),
    );
    if (contextual.length === 1) return contextual[0];
  }
  return positions.length === 1 ? positions[0] : undefined;
}

function storeRequestIndex(store: import("../storage/repository.js").Repository, turnId: string): number {
  return store
    .feedbackList("manifest")
    .filter(
      (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.get(value, "turnId") === turnId,
    ).length;
}
