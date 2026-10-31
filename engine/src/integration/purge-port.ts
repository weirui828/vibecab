import { createHash } from "node:crypto";
import { fail, type Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import type { FeedbackPort } from "../feedback/index.js";
import type { TmrPort } from "../tmr/index.js";
import { canonical } from "../kernel/canonical.js";

export type ReviewPurgeTarget = { kind: "artifact" | "session" | "comment" | "idea" | "project"; id: string };
export type ReviewRunPreview = {
  reviewRequestId: string;
  runId: string;
  action: "redact" | "delete";
  active: boolean;
  removes: string[];
};
export interface IntegrationPurgePort {
  preview(ctx: ModuleContext, target: ReviewPurgeTarget): ReviewRunPreview[];
  apply(ctx: ModuleContext, target: ReviewPurgeTarget): void;
}

export function integrationPurgePort(ports: { feedback: FeedbackPort; tmr: TmrPort }): IntegrationPurgePort {
  const requests = (ctx: ModuleContext) =>
      ctx.repository.feedbackList("review-request").map((value) => ctx.contract.read<Json>("review-request", value)),
    sourcesFor = (ctx: ModuleContext, request: Json, target: ReviewPurgeTarget): string[] => {
      const snapshot = ctx.repository.feedback("review-snapshot", string(field(request, "reviewRequestId")));
      if (!snapshot) return [];
      const items = snapshot;
      if (!Array.isArray(items)) return [];
      const sessionComments =
        target.kind === "session"
          ? new Set(
              ctx.repository
                .feedbackList("comment")
                .map((value) => ctx.contract.read<Json>("feedback-comment", value))
                .filter((comment) => field(comment, "sessionId") === target.id)
                .map((comment) => field(comment, "commentId"))
                .filter((id): id is string => typeof id === "string"),
            )
          : undefined;
      return items
        .map((item) => field(item, "source"))
        .filter(
          (source): source is string => typeof source === "string" && sourceBelongsTo(target, source, sessionComments),
        );
    },
    preview = (ctx: ModuleContext, target: ReviewPurgeTarget): ReviewRunPreview[] =>
      requests(ctx).flatMap((request) => {
        const sources = sourcesFor(ctx, request, target);
        if (!sources.length) return [];
        const reviewRequestId = string(field(request, "reviewRequestId")),
          runId = optionalString(field(request, "runId")) ?? ports.tmr.findRunByRequestId(ctx, reviewRequestId)?.runId;
        if (!runId) return [];
        const snapshot = ctx.repository.feedback("review-snapshot", reviewRequestId),
          rawItems = snapshot,
          allSources = Array.isArray(rawItems)
            ? rawItems
                .map((item) => field(item, "source"))
                .filter((source): source is string => typeof source === "string")
            : [],
          action =
            allSources.length > 0 && allSources.every((source) => sources.includes(source)) ? "delete" : "redact",
          active = ["queued", "running"].includes(ports.tmr.run(ctx, runId).status);
        return [
          {
            reviewRequestId,
            runId,
            action,
            active,
            removes:
              action === "delete"
                ? ["review run", "snapshot", "contributions", "report", "events", "review comments"]
                : ["purged source content", "quoted text in contributions, report and review comments"],
          },
        ];
      });
  return {
    preview,
    apply(ctx, target) {
      for (const review of preview(ctx, target)) {
        if (review.active) fail("conflict", "An active review still refers to this content");
        const request = requests(ctx).find((item) => field(item, "reviewRequestId") === review.reviewRequestId);
        if (!request) fail("conflict", "Dependent review request changed during purge");
        const sources = sourcesFor(ctx, request, target);
        for (const job of ctx.repository.jobs()) {
          const payloadRequestId = field(job.payload, "reviewRequestId");
          if (job.kind === "integration.review.submit" && payloadRequestId === review.reviewRequestId)
            ctx.repository.deleteJob(job.id);
        }
        const affectedFindingIds = ports.tmr.purgeSources(ctx, review.runId, sources, review.action === "delete");
        ports.feedback.purgeRunComments(ctx, review.runId, review.action, affectedFindingIds);
        ctx.repository.deleteFeedback("review-delivery", review.runId);
        if (review.action === "delete") {
          ctx.repository.deleteFeedback("review-snapshot", review.reviewRequestId);
          ctx.repository.deleteFeedback("review-request", review.reviewRequestId);
        } else {
          const rawItems = ctx.repository.feedback("review-snapshot", review.reviewRequestId),
            redactedIds: string[] = [];
          if (Array.isArray(rawItems)) {
            const redacted = rawItems.map((item) => {
              const source = field(item, "source");
              if (typeof source !== "string" || !sources.includes(source)) return item;
              const itemId = field(item, "itemId"),
                content = field(item, "content");
              if (typeof itemId === "string") redactedIds.push(itemId);
              return { ...record(item), content: tombstone(content) };
            });
            ctx.repository.saveFeedback(
              "review-snapshot",
              review.reviewRequestId,
              ctx.contract.read<Json>("json", redacted),
            );
          }
          const sourceMap = field(request, "sourceMap"),
            retainedMap = record(sourceMap);
          for (const id of redactedIds) delete retainedMap[id];
          ctx.repository.saveFeedback(
            "review-request",
            review.reviewRequestId,
            ctx.contract.read<Json>("review-request", { ...record(request), sourceMap: retainedMap }),
          );
        }
      }
    },
  };
}

function sourceBelongsTo(target: ReviewPurgeTarget, source: string, sessionComments?: ReadonlySet<string>): boolean {
  if (target.kind === "artifact") return sourceMatches(source, `vc:artifact/${target.id}`);
  if (target.kind === "comment") return sourceMatches(source, `vc:comment/${target.id}`);
  if (target.kind === "session")
    return [...(sessionComments ?? [])].some((commentId) => sourceMatches(source, `vc:comment/${commentId}`));
  return false;
}
function sourceMatches(value: string, prefix: string): boolean {
  return value === prefix || ["@", "#", "/"].some((separator) => value.startsWith(prefix + separator));
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function string(value: unknown): string {
  if (typeof value !== "string") fail("invalid", "Expected string");
  return value;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function record(value: unknown): Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? jsonRecord(value) : {};
}
function jsonRecord(value: object): Record<string, Json> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Json] => isJson(entry[1])));
}
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && value !== null && Object.values(value).every(isJson);
}
function tombstone(value: unknown): Json {
  const text = canonical(value),
    hash = createHash("sha256").update(text).digest("hex");
  return { redacted: true, hash, length: text.length };
}
