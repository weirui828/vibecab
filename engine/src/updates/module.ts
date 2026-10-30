import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";
import type { Agreement, Json, Job, Update } from "../../../contract/src/index.js";

export function updatesModule(host: EngineModuleHost) {
  const engineModule = createModule(
    "updates",
    host,
    ["vc.StartUpdate", "vc.CancelUpdate", "vc.ApprovePlan"],
    ["vc.Updates", "vc.UpdateDetail"],
    { "agent.update": "rerun" },
  );
  engineModule.recover = (context) => {
    for (const job of context.repository.jobs()) {
      if (job.kind !== "agent.update" || !["leased", "interrupted"].includes(job.state)) continue;
      const updateId = payloadString(job, "updateId");
      if (!updateId) continue;
      context.budgets?.markTurnUncertain(updateId);
      const raw = context.repository.feedback("update", updateId);
      if (!raw) continue;
      const update = context.contract.read<Update>("update", raw);
      if (!["committed", "partially_committed", "failed", "cancelled"].includes(update.status)) {
        for (const itemId of update.itemIds) {
          const row = context.repository.feedback("agreement", itemId);
          if (!row) continue;
          const agreement = context.contract.read<Agreement>("agreement", row);
          if (agreement.state === "scheduled")
            context.repository.saveFeedback(
              "agreement",
              itemId,
              context.contract.read<Json>("json", { ...agreement, state: "agreed" }),
            );
        }
        context.repository.saveFeedback(
          "update",
          updateId,
          context.contract.read<Json>("json", {
            ...update,
            status: "failed",
            updatedAt: context.clock.now(),
            itemResults: update.itemIds.map((itemId) => ({
              itemId,
              status: "not_addressed",
              reason: "Update was interrupted; no changes were committed.",
            })),
          }),
        );
      }
      context.repository.jobState(job.id, "uncertain");
    }

    for (const raw of context.repository.feedbackList("update")) {
      const update = context.contract.read<Update>("update", raw);
      if (update.status !== "awaiting_plan_review") continue;
      for (const itemId of update.itemIds) {
        const agreementRow = context.repository.feedback("agreement", itemId);
        if (!agreementRow) continue;
        const agreement = context.contract.read<Agreement>("agreement", agreementRow);
        if (agreement.state === "scheduled")
          context.repository.saveFeedback(
            "agreement",
            itemId,
            context.contract.read<Json>("json", { ...agreement, state: "agreed" }),
          );
      }
      context.repository.saveFeedback(
        "update",
        update.updateId,
        context.contract.read<Json>("json", {
          ...update,
          status: "failed",
          updatedAt: context.clock.now(),
          itemResults: update.itemIds.map((itemId) => ({
            itemId,
            status: "not_addressed",
            reason: "Update was interrupted while awaiting plan review; no changes were committed.",
          })),
        }),
      );
    }
  };
  return engineModule;
}

function payloadString(job: Job, key: string): string | undefined {
  const payload = job.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, key);
  return typeof value === "string" ? value : undefined;
}
