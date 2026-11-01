import { errorOf, fail } from "../../../contract/src/index.js";
import type { Json, FeedbackComment, Agreement, Update } from "../../../contract/src/index.js";
import type { ModelRequest as GatewayRequest } from "../gateway/types.js";
import { UpdatePlanningRuntime } from "./planning-runtime.js";
import { discussionFor } from "./helpers.js";

export abstract class UpdateWritingRuntime extends UpdatePlanningRuntime {
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
              this.contract.read<Json>("json", { ...current, status: "writing", updatedAt: this.deps.clock.now() }),
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
            discussion: discussionFor(comments, a.commentId),
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
            this.contract.read<Json>("json", { ...current, status: "checking", updatedAt: this.deps.clock.now() }),
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
            updatedAt: this.deps.clock.now(),
            ...(resultVersion ? { resultVersion } : {}),
            itemResults: normalized,
          }),
        );
      }),
    );
  }
}
