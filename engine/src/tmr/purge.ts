import { type Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import type { Run } from "./types.js";

export function purgeBySource(ctx: ModuleContext, source: string): Json {
  let purged = 0;
  const runs = ctx.repository.feedbackList("tmr-run").map((value) => ctx.contract.read<Run>("tmr/run", value));
  for (const run of runs) {
    const snapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
      items = field(snapshot, "items");
    if (!Array.isArray(items) || !items.some((item) => sourceMatches(field(item, "source"), source))) continue;
    ctx.repository.deleteFeedback("tmr-snapshot", run.snapshotId);
    ctx.repository.deleteFeedback("tmr-run", run.runId);
    ctx.repository.deleteFeedback("tmr-report", run.runId);
    deleteRunRecords(ctx, "tmr-contribution", run.runId, "tmr/contribution", (record) =>
      field(record, "contributionId"),
    );
    deleteRunRecords(ctx, "tmr-failure", run.runId, "tmr/contribution-failure", (record) =>
      [run.runId, field(record, "stageId"), field(record, "participantId")].join(":"),
    );
    deleteRunRecords(ctx, "tmr-event", run.runId, "json", (record) => field(record, "eventId"));
    purged++;
  }
  return { purged };
}

function deleteRunRecords(
  ctx: ModuleContext,
  kind: string,
  runId: string,
  schema: string,
  key: (record: Json) => unknown,
): void {
  for (const value of ctx.repository.feedbackList(kind)) {
    const record = ctx.contract.read<Json>(schema, value);
    if (field(record, "runId") !== runId) continue;
    const id = key(record);
    if (typeof id === "string") ctx.repository.deleteFeedback(kind, id);
  }
}

function sourceMatches(value: unknown, prefix: string): boolean {
  return (
    typeof value === "string" &&
    (value === prefix || ["@", "#", "/"].some((separator) => value.startsWith(prefix + separator)))
  );
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
