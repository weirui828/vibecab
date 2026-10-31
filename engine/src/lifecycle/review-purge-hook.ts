import type { TrashRecord } from "../../../contract/src/index.js";

export type TrashTarget = { kind: TrashRecord["kind"]; id: string };
export type ReviewPurgeRunPreview = {
  reviewRequestId: string;
  runId: string;
  action: "redact" | "delete";
  active: boolean;
  removes: string[];
};

export interface ReviewPurgeHook {
  preview(target: TrashTarget): ReviewPurgeRunPreview[];
  apply(target: TrashTarget): void;
}
