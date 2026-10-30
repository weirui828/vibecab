import { fail, type Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import { reviewRun, submitReview } from "./module.js";
export { tmrModule } from "./module.js";
import { dependentRuns, purgeRun } from "./purge.js";
import type { Run } from "./types.js";

export interface TmrPort {
  submit(ctx: ModuleContext, payload: Record<string, Json>): Json;
  run(ctx: ModuleContext, runId: string): Run;
  findRunByRequestId(ctx: ModuleContext, requestId: string): Run | undefined;
  report(ctx: ModuleContext, runId: string): Json;
  events(ctx: ModuleContext, runId: string, cursor: number): { events: Json[]; cursor: number };
  dependentRuns(ctx: ModuleContext, source: string): string[];
  purgeRun(ctx: ModuleContext, runId: string, action: "redact" | "delete"): void;
}

export function tmrPort(): TmrPort {
  return {
    submit: submitReview,
    run: reviewRun,
    findRunByRequestId(ctx, requestId) {
      return ctx.repository
        .feedbackList("tmr-run")
        .map((value) => ctx.contract.read<Run>("tmr/run", value))
        .find((run) => run.requestId === requestId);
    },
    report(ctx, runId) {
      const report = ctx.repository.feedback("tmr-report", runId);
      if (!report) fail("not_found", "TMR report not found");
      return ctx.contract.read<Json>("tmr/report", report);
    },
    events(ctx, runId, cursor) {
      const all = ctx.repository
        .feedbackList("tmr-event")
        .map((value) => ctx.contract.read<Json>("json", value))
        .filter((event) => field(event, "runId") === runId);
      return { events: all.slice(cursor), cursor: all.length };
    },
    dependentRuns,
    purgeRun,
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
