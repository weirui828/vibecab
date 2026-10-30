import { createHash } from "node:crypto";
import { type Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import type { Run } from "./types.js";
import { canonical } from "../kernel/canonical.js";

export function purgeBySource(ctx: ModuleContext, source: string): Json {
  let purged = 0;
  const runs = ctx.repository.feedbackList("tmr-run").map((value) => ctx.contract.read<Run>("tmr/run", value));
  for (const run of runs) {
    const rawSnapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
      snapshot = rawSnapshot ? ctx.contract.read<Json>("tmr/snapshot", rawSnapshot) : undefined,
      items = field(snapshot, "items");
    if (!Array.isArray(items) || !items.some((item) => sourceMatches(field(item, "source"), source))) continue;
    purgeRun(ctx, run.runId, "delete");
    purged++;
  }
  return { purged };
}

export function dependentRuns(ctx: ModuleContext, source: string): string[] {
  return ctx.repository
    .feedbackList("tmr-run")
    .map((value) => ctx.contract.read<Run>("tmr/run", value))
    .filter((run) => {
      const rawSnapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
        snapshot = rawSnapshot ? ctx.contract.read<Json>("tmr/snapshot", rawSnapshot) : undefined,
        items = field(snapshot, "items");
      return Array.isArray(items) && items.some((item) => sourceMatches(field(item, "source"), source));
    })
    .map((run) => run.runId);
}

export function purgeRun(ctx: ModuleContext, runId: string, action: "redact" | "delete"): void {
  const raw = ctx.repository.feedback("tmr-run", runId);
  if (!raw) return;
  const run = ctx.contract.read<Run>("tmr/run", raw),
    rawSnapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
    snapshot = rawSnapshot ? ctx.contract.read<Json>("tmr/snapshot", rawSnapshot) : undefined;
  if (action === "delete") {
    ctx.repository.deleteFeedback("tmr-snapshot", run.snapshotId);
    ctx.repository.deleteFeedback("tmr-run", runId);
    ctx.repository.deleteFeedback("tmr-report", runId);
    deleteRunRecords(ctx, "tmr-contribution", runId, "tmr/contribution", (record) => field(record, "contributionId"));
    deleteRunRecords(ctx, "tmr-failure", runId, "tmr/contribution-failure", (record) =>
      [runId, field(record, "stageId"), field(record, "participantId")].join(":"),
    );
    deleteRunRecords(ctx, "tmr-event", runId, "json", (record) => field(record, "eventId"));
    return;
  }
  if (snapshot) {
    const items = field(snapshot, "items");
    if (Array.isArray(items)) {
      const redacted = items.map((item) => ({ ...asRecord(item), content: tombstone(field(item, "content")) }));
      ctx.repository.saveFeedback(
        "tmr-snapshot",
        run.snapshotId,
        ctx.contract.read<Json>("tmr/snapshot", { ...asRecord(snapshot), items: redacted }),
      );
    }
  }
  for (const value of ctx.repository.feedbackList("tmr-contribution")) {
    const record = ctx.contract.read<Json>("tmr/contribution", value);
    if (field(record, "runId") === runId) {
      const id = field(record, "contributionId");
      if (typeof id === "string")
        ctx.repository.saveFeedback(
          "tmr-contribution",
          id,
          ctx.contract.read<Json>("tmr/contribution", {
            ...asRecord(record),
            content: tombstone(field(record, "content")),
          }),
        );
    }
  }
  ctx.repository.deleteFeedback("tmr-report", runId);
}

function tombstone(value: unknown): Json {
  const serialized = canonical(value),
    hash = createHash("sha256").update(serialized).digest("hex");
  return { redacted: true, hash, length: serialized.length };
}
function asRecord(value: unknown): Record<string, Json> {
  return isJsonRecord(value) ? value : {};
}
function isJsonRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJson);
}
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isJsonRecord(value);
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
