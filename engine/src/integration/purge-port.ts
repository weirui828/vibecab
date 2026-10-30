import { fail, type Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import type { FeedbackPort } from "../feedback/index.js";
import type { TmrPort } from "../tmr/index.js";

export type ReviewPurgeTarget = { kind: "artifact" | "session" | "comment" | "idea" | "project"; id: string };
export type ReviewPurgeAction = { runId: string; action: "redact" | "delete" };
export type ReviewRunPreview = {
  reviewRequestId: string;
  runId: string;
  redactRemoves: string[];
  deleteRemoves: string[];
};
export interface IntegrationPurgePort {
  preview(ctx: ModuleContext, target: ReviewPurgeTarget): ReviewRunPreview[];
  apply(ctx: ModuleContext, target: ReviewPurgeTarget, actions: readonly ReviewPurgeAction[]): void;
}

export function integrationPurgePort(ports: { feedback: FeedbackPort; tmr: TmrPort }): IntegrationPurgePort {
  const preview = (ctx: ModuleContext, target: ReviewPurgeTarget): ReviewRunPreview[] => {
    const requests = ctx.repository
      .feedbackList("review-request")
      .map((value) => ctx.contract.read<Json>("review-request", value));
    return requests.flatMap((request) => {
      const requestId = string(field(request, "reviewRequestId"));
      if (!dependsOn(ctx, request, target)) return [];
      const runId = optionalString(field(request, "runId")) ?? ports.tmr.findRunByRequestId(ctx, requestId)?.runId;
      if (!runId) return [];
      return [
        {
          reviewRequestId: requestId,
          runId,
          redactRemoves: ["snapshot item text", "model contribution text", "report text", "quoted finding text"],
          deleteRemoves: ["TMR run", "snapshot", "contributions", "report", "review comments"],
        },
      ];
    });
  };
  return {
    preview,
    apply(ctx, target, actions) {
      const expected = preview(ctx, target)
          .map((item) => item.runId)
          .sort(),
        supplied = actions.map((action) => action.runId).sort();
      if (expected.length !== supplied.length || expected.some((runId, index) => runId !== supplied[index]))
        fail("invalid", "Purge choices do not match dependent review runs");
      const requests = ctx.repository
        .feedbackList("review-request")
        .map((value) => ctx.contract.read<Json>("review-request", value));
      for (const action of actions) {
        const request = requests.find(
          (item) =>
            field(item, "runId") === action.runId ||
            ports.tmr.findRunByRequestId(ctx, string(field(item, "reviewRequestId")))?.runId === action.runId,
        );
        if (!request) fail("conflict", "Dependent review request changed during purge");
        ports.tmr.purgeRun(ctx, action.runId, action.action);
        ports.feedback.purgeRunComments(ctx, action.runId, action.action);
        const requestId = string(field(request, "reviewRequestId"));
        ctx.repository.deleteFeedback("review-snapshot", requestId);
        ctx.repository.deleteFeedback("review-delivery", action.runId);
        if (action.action === "delete") ctx.repository.deleteFeedback("review-request", requestId);
      }
    },
  };
}

function dependsOn(ctx: ModuleContext, request: Json, target: ReviewPurgeTarget): boolean {
  if (target.kind === "session" && field(request, "sessionId") === target.id) return true;
  const rawItems = ctx.repository.feedback("review-snapshot", string(field(request, "reviewRequestId")));
  if (!Array.isArray(rawItems)) return false;
  const items = ctx.contract.read<Json>("json", rawItems);
  if (!Array.isArray(items)) return false;
  const prefix =
    target.kind === "artifact"
      ? `vc:artifact/${target.id}`
      : target.kind === "comment"
        ? `vc:comment/${target.id}`
        : undefined;
  return prefix !== undefined && items.some((item) => sourceMatches(field(item, "source"), prefix));
}
function sourceMatches(value: unknown, prefix: string): boolean {
  return (
    typeof value === "string" &&
    (value === prefix || ["@", "#", "/"].some((separator) => value.startsWith(prefix + separator)))
  );
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
