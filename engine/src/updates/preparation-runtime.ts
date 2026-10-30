import { errorOf, fail } from "../../../contract/src/index.js";
import type { Json, FeedbackComment, Agreement, Update, Job } from "../../../contract/src/index.js";
import { AgentRuntime } from "../agent/runtime.js";
import { findVerbatimQuote } from "./helpers.js";
import { inlineMarkdownToPlainText, replaceInlineMarkdownText } from "../../../contract/src/inline-markdown.js";

export abstract class UpdatePreparationRuntime extends AgentRuntime {
  protected abstract judgeUpdateConflicts(
    update: Update,
    agreements: Agreement[],
  ): Promise<{ agreements: Agreement[]; blocked: Update["itemResults"] }>;
  protected abstract planUpdate(
    update: Update,
    items: Agreement[],
    comments: FeedbackComment[],
    elements: import("../../../contract/src/index.js").Element[],
    alreadyChanged: import("../../../contract/src/index.js").CommitInput["changes"],
  ): Promise<import("../../../contract/src/index.js").UpdatePlan | undefined>;
  protected abstract runUpdateWriter(
    update: Update,
    remaining: Agreement[],
    agreements: Agreement[],
    comments: FeedbackComment[],
    elements: import("../../../contract/src/index.js").Element[],
    direct: import("../../../contract/src/index.js").CommitInput["changes"],
    directResults: Update["itemResults"],
    providedPlan?: import("../../../contract/src/index.js").UpdatePlan,
  ): Promise<void>;
  protected abstract finishUpdate(
    update: Update,
    agreements: Agreement[],
    results: Update["itemResults"],
    changes: import("../../../contract/src/index.js").CommitInput["changes"],
    expectedVersion?: number,
  ): Promise<void>;
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
        updatedAt: this.deps.clock.now(),
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
    store.saveFeedback(
      "update",
      p.updateId,
      this.contract.read<Json>("json", { ...update, status: "cancelled", updatedAt: this.deps.clock.now() }),
    );
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
    store.saveFeedback(
      "update",
      p.updateId,
      this.contract.read<Json>("json", { ...update, status: "writing", updatedAt: this.deps.clock.now() }),
    );
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
              updatedAt: this.deps.clock.now(),
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
      const plainText = inlineMarkdownToPlainText(currentText),
        at = findVerbatimQuote(plainText, quote, anchor.locator?.prefix, anchor.locator?.suffix);
      if (at === undefined) {
        remaining.push(agreement);
        continue;
      }
      const draft = this.contract.read<import("../../../contract/src/index.js").ElementDraft>("element-draft", {
        type: element.type,
        props: element.props,
        text: replaceInlineMarkdownText(currentText, at, at + quote.length, replacement),
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
                    updatedAt: this.deps.clock.now(),
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
}
