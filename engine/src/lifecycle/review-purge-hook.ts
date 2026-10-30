import type { TrashRecord } from "../../../contract/src/index.js";

export type TrashTarget = { kind: TrashRecord["kind"]; id: string };
export type ReviewPurgeAction = { runId: string; action: "redact" | "delete" };
export type ReviewPurgeRunPreview = {
  reviewRequestId: string;
  runId: string;
  redactRemoves: string[];
  deleteRemoves: string[];
};

export interface ReviewPurgeHook {
  preview(target: TrashTarget): ReviewPurgeRunPreview[];
  apply(target: TrashTarget, actions: readonly ReviewPurgeAction[]): void;
}
