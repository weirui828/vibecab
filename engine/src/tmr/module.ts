import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { errorOf, fail, type Json } from "../../../contract/src/index.js";
import type { EngineModule, ModuleContext } from "../kernel/module-registry.js";
import { canonical } from "../kernel/canonical.js";
import { estimateReservationMicros } from "../gateway/ledger.js";
import type { ModelRequest, ProviderModel } from "../gateway/types.js";
import { snapshotId, stageContext, validateProcess } from "./process.js";
import type { ProcessSpec } from "./process.js";
import { finish, markdownReport, saveRun } from "./report.js";
import type { Run } from "./types.js";
import { purgeBySource } from "./purge.js";

const commands = ["tmr.Submit", "tmr.Cancel", "tmr.Resume", "tmr.PurgeBySource"],
  queries = ["tmr.Run", "tmr.Runs", "tmr.Report", "tmr.Events", "tmr.Export"];

export function tmrModule(): EngineModule {
  const activeCalls = new Map<string, Set<AbortController>>();
  return {
    name: "tmr",
    commands: Object.fromEntries(
      commands.map((name) => [
        name,
        (ctx, _call, command) => {
          const p = ctx.contract.read<Record<string, Json>>(
            "operations/" + name,
            command.payload,
            "#/properties/payload",
          );
          if (name === "tmr.Submit") return submit(ctx, p);
          if (name === "tmr.Cancel") return cancelRun(ctx, str(p, "runId"), activeCalls);
          if (name === "tmr.Resume") return resume(ctx, str(p, "runId"));
          if (name === "tmr.PurgeBySource") return purgeBySource(ctx, str(p, "source"));
          fail("unsupported", "Unsupported TMR command");
        },
      ]),
    ),
    queries: Object.fromEntries(
      queries.map((name) => [
        name,
        (ctx, _call, query) => {
          const p = ctx.contract.read<Record<string, Json>>("operations/" + name, query.args, "#/properties/payload");
          if (name === "tmr.Run") return getRun(ctx, str(p, "runId"));
          if (name === "tmr.Runs") return listRuns(ctx).slice(0, num(p.limit) ?? 100);
          if (name === "tmr.Report") {
            const run = getRun(ctx, str(p, "runId")),
              r = ctx.repository.feedback("tmr-report", run.runId);
            if (!r) fail("not_found", "TMR report not found");
            return ctx.contract.read<Json>("tmr/report", r);
          }
          if (name === "tmr.Events")
            return ctx.repository
              .feedbackList("tmr-event")
              .map((x) => ctx.contract.read<Json>("json", x))
              .filter((x) => field(x, "runId") === p.runId);
          const run = getRun(ctx, str(p, "runId")),
            report = ctx.repository.feedback("tmr-report", run.runId);
          if (!report) fail("not_found", "TMR report not found");
          const value = ctx.contract.read<Json>("tmr/report", report);
          return p.format === "markdown" ? { content: markdownReport(value) } : { content: value };
        },
      ]),
    ),
    jobKinds: {
      "tmr.stage": { onLostLease: "uncertain", run: (ctx, job) => runContribution(ctx, job, activeCalls) },
    },
    recover(ctx) {
      for (const run of listRuns(ctx)) {
        if (run.status !== "running") continue;
        const interrupted = { ...run, status: "interrupted", outcome: "interrupted" };
        finish(ctx, interrupted);
      }
    },
  };
}

function submit(ctx: ModuleContext, p: Record<string, Json>): Json {
  const participants = ctx.contract.read<Run["participants"]>("json", p.participants),
    ids = participants.map((x) => x.participantId);
  if (!ids.length || new Set(ids).size !== ids.length) fail("invalid", "TMR participants need unique ids");
  for (const participant of participants) ctx.contract.read("tmr/participant", participant);
  const spec = ctx.contract.read<ProcessSpec>("tmr/process-spec", p.processSpec);
  validateProcess(spec, ids);
  if (spec.stages.some((stage) => !ctx.contract.schemaIsValid(stage.outputSchema)))
    fail("invalid", "TMR stage output schema is invalid");
  const payloadHash = createHash("sha256").update(canonical(p)).digest("hex"),
    requestId = str(p, "requestId"),
    existing = listRuns(ctx).find((x) => x.requestId === requestId);
  if (existing) {
    if (existing.payloadHash !== payloadHash) fail("conflict", "TMR request id reused with different payload");
    return { runId: existing.runId, status: existing.status };
  }
  const items = ctx.contract.read<Json[]>("json", p.items),
    sid = snapshotId(items),
    snapshot = { snapshotId: sid, items };
  ctx.contract.read("tmr/snapshot", snapshot);
  const runId = ctx.ids.next("tmr_run_"),
    limits = ctx.contract.read<Run["limits"]>("json", p.limits),
    stagePrompts = Object.fromEntries(
      [...new Set(spec.stages.map((stage) => stage.kind))].map((kind) => [kind, loadStagePrompt(kind)]),
    ),
    promptHashes = Object.fromEntries(
      Object.entries(stagePrompts).map(([kind, prompt]) => [kind, createHash("sha256").update(prompt).digest("hex")]),
    );
  if (p.mode === "live") {
    if (!ctx.gateway || !ctx.budgets) fail("unavailable", "Live TMR gateway unavailable");
    ctx.budgets.setRunLimit(runId, limits.spendMicros);
  }
  const run = ctx.contract.read<Run>("tmr/run", {
    runId,
    requestId,
    payloadHash,
    question: str(p, "question"),
    snapshotId: sid,
    criteria: ctx.contract.read<string[]>("json", p.criteria),
    processSpec: spec,
    processHash: createHash("sha256").update(canonical(spec)).digest("hex"),
    promptHashes,
    stagePrompts,
    participants,
    limits,
    mode: p.mode,
    status: "queued",
    createdAt: ctx.clock.now(),
    ...(p.intendedUse ? { intendedUse: str(p, "intendedUse") } : {}),
    ...(p.rerunOf ? { rerunOf: str(p, "rerunOf") } : {}),
  });
  ctx.repository.saveFeedback("tmr-snapshot", sid, ctx.contract.read<Json>("json", snapshot));
  saveRun(ctx, run);
  enqueue(ctx, run, 0);
  return { runId, status: run.status };
}
function enqueue(ctx: ModuleContext, run: Run, index: number): void {
  const current = maybeRun(ctx, run.runId);
  if (!current || terminal(current.status)) return;
  run = current;
  const stage = run.processSpec.stages[index];
  if (!stage) return;
  const assigned = stage.participants === "all" ? run.participants.map((x) => x.participantId) : stage.participants;
  const dispatchId = ctx.ids.next("tmr_dispatch_");
  for (const participantId of assigned) {
    const contributionId = run.runId + ":" + stage.id + ":" + participantId,
      pending = ctx.repository.jobs().some((job) => {
        const payload = job.payload;
        return (
          job.kind === "tmr.stage" &&
          job.state === "pending" &&
          field(payload, "runId") === run.runId &&
          field(payload, "stageId") === stage.id &&
          field(payload, "participantId") === participantId
        );
      });
    if (ctx.repository.feedback("tmr-contribution", contributionId) || pending) continue;
    const id = run.runId + ":" + stage.id + ":" + dispatchId + ":" + participantId,
      reservationId = ctx.ids.next("reservation_");
    ctx.enqueue(
      "tmr.stage",
      id,
      ctx.contract.read<Json>("json", {
        runId: run.runId,
        stageId: stage.id,
        participantId,
        index,
        reservationId,
        attempt: 0,
      }),
      ctx.clock.now(),
    );
  }
  recordProgress(ctx, run.runId, "stage_started", { stageId: stage.id, expected: assigned.length, actual: 0 });
  saveRun(ctx, { ...run, status: "running" });
}
async function runContribution(
  ctx: ModuleContext,
  job: import("../../../contract/src/index.js").Job,
  activeCalls: Map<string, Set<AbortController>>,
): Promise<void> {
  const runId = str(job.payload, "runId"),
    stageId = str(job.payload, "stageId"),
    participantId = str(job.payload, "participantId"),
    index = num(field(job.payload, "index")) ?? 0,
    run = getRun(ctx, runId),
    stage = run.processSpec.stages[index];
  if (!stage || stage.id !== stageId || terminal(run.status) || !(await ctx.mutate(() => holdsLease(ctx, job)))) return;
  const contributionId = runId + ":" + stageId + ":" + participantId;
  if (!ctx.repository.feedback("tmr-contribution", contributionId)) {
    const participant = run.participants.find((p) => p.participantId === participantId);
    if (!participant) fail("internal", "TMR participant missing");
    let content: Json;
    try {
      await ctx.mutate(() => ctx.repository.deleteFeedback("tmr-failure", contributionId));
      content =
        run.mode === "demo"
          ? ctx.contract.read<Json>("json", {
              recommendation: "Demo assessment for: " + run.question,
              findings: [],
              participantId,
              stage: stage.kind,
              demo: true,
            })
          : await liveContribution(
              ctx,
              run,
              stage,
              participant,
              contributionId,
              str(job.payload, "reservationId"),
              activeCalls,
            );
    } catch (error) {
      const current = maybeRun(ctx, runId);
      if (current && terminal(current.status)) return;
      if (errorOf(error).code === "budget_exceeded") {
        await ctx.mutate(() => {
          const latest = maybeRun(ctx, runId);
          if (latest && !terminal(latest.status) && holdsLease(ctx, job))
            finish(ctx, { ...latest, status: "limit_reached", outcome: "limit_reached" });
        });
        return;
      }
      const retryPolicy =
          typeof run.processSpec.onMissingContribution === "object" ? run.processSpec.onMissingContribution : undefined,
        attempt = num(field(job.payload, "attempt")) ?? 0;
      if (retryPolicy && attempt < retryPolicy.retry) {
        const retryPayload = ctx.contract.read<Record<string, Json>>("json", job.payload);
        await ctx.mutate(() => {
          const latest = maybeRun(ctx, runId);
          if (!latest || terminal(latest.status) || !holdsLease(ctx, job)) return;
          ctx.enqueue(
            "tmr.stage",
            job.id + ":retry:" + (attempt + 1),
            ctx.contract.read<Json>("json", {
              ...retryPayload,
              reservationId: ctx.ids.next("reservation_"),
              attempt: attempt + 1,
            }),
            ctx.clock.now(),
          );
        });
        await ctx.mutate(() =>
          recordProgress(ctx, runId, "retry_scheduled", { stageId, participantId, actual: attempt + 1 }),
        );
        return;
      }
      const failure = ctx.contract.read<Json>("tmr/contribution-failure", {
        runId,
        stageId,
        participantId,
        createdAt: ctx.clock.now(),
        code: "contribution_failed",
      });
      await ctx.mutate(() => {
        const latest = maybeRun(ctx, runId);
        if (!latest || terminal(latest.status) || !holdsLease(ctx, job)) return;
        ctx.repository.saveFeedback("tmr-failure", contributionId, failure);
        recordProgress(ctx, runId, "contribution_failed", { stageId, participantId });
        if (missingFailureMode(run.processSpec) === "fail")
          finish(ctx, { ...latest, status: "failed", outcome: "failed" });
        else advanceWhenSettled(ctx, latest, stage, index, assignedParticipants(latest, stage));
      });
      return;
    }
    const contribution = ctx.contract.read<Json>("tmr/contribution", {
      contributionId,
      runId,
      stageId,
      participantId,
      content,
      createdAt: ctx.clock.now(),
      mode: run.mode,
    });
    await ctx.mutate(() => {
      const latest = maybeRun(ctx, runId);
      if (!latest || terminal(latest.status) || !holdsLease(ctx, job)) return;
      ctx.repository.saveFeedback("tmr-contribution", contributionId, contribution);
      const actual = assignedParticipants(latest, stage).filter((id) =>
        Boolean(ctx.repository.feedback("tmr-contribution", runId + ":" + stageId + ":" + id)),
      ).length;
      recordProgress(ctx, runId, "contribution_recorded", { stageId, participantId, actual });
      advanceWhenSettled(ctx, latest, stage, index, assignedParticipants(latest, stage));
    });
    return;
  }
  await ctx.mutate(() => {
    const latest = maybeRun(ctx, runId);
    if (latest && !terminal(latest.status) && holdsLease(ctx, job))
      advanceWhenSettled(ctx, latest, stage, index, assignedParticipants(latest, stage));
  });
}
function assignedParticipants(run: Run, stage: ProcessSpec["stages"][number]): string[] {
  return stage.participants === "all" ? run.participants.map((x) => x.participantId) : stage.participants;
}
function advanceWhenSettled(
  ctx: ModuleContext,
  run: Run,
  stage: ProcessSpec["stages"][number],
  index: number,
  assigned: string[],
): void {
  const current = maybeRun(ctx, run.runId);
  if (!current || terminal(current.status)) return;
  run = current;
  const accounted = assigned.filter((id) => {
    const key = run.runId + ":" + stage.id + ":" + id;
    return Boolean(ctx.repository.feedback("tmr-contribution", key) || ctx.repository.feedback("tmr-failure", key));
  });
  if (accounted.length < assigned.length) return;
  const contributionCount = assigned.filter((id) =>
    ctx.repository.feedback("tmr-contribution", run.runId + ":" + stage.id + ":" + id),
  ).length;
  if (contributionCount < stage.quorum) {
    recordProgress(ctx, run.runId, "stage_failed", {
      stageId: stage.id,
      expected: assigned.length,
      actual: contributionCount,
    });
    finish(ctx, { ...run, status: "failed", outcome: "failed" });
    return;
  }
  recordProgress(ctx, run.runId, "stage_completed", {
    stageId: stage.id,
    expected: assigned.length,
    actual: contributionCount,
  });
  if (index + 1 < run.processSpec.stages.length) enqueue(ctx, run, index + 1);
  else finish(ctx, run);
}
function missingFailureMode(spec: ProcessSpec): "fail" | "proceed_disclosed" {
  return typeof spec.onMissingContribution === "string" ? spec.onMissingContribution : spec.onMissingContribution.then;
}
async function liveContribution(
  ctx: ModuleContext,
  run: Run,
  stage: ProcessSpec["stages"][number],
  participant: Run["participants"][number],
  key: string,
  reservationId: string,
  activeCalls: Map<string, Set<AbortController>>,
): Promise<Json> {
  if (!ctx.gateway || !ctx.budgets) fail("unavailable", "Live TMR model gateway unavailable");
  const snapshot = ctx.contract.read<Json>("tmr/snapshot", ctx.repository.feedback("tmr-snapshot", run.snapshotId)),
    prior: Record<string, Json[]> = {};
  for (const input of stage.inputs)
    if (input.startsWith("stage:")) {
      const stageId = input.slice(6);
      prior[stageId] = ctx.repository
        .feedbackList("tmr-contribution")
        .map((x) => ctx.contract.read<Json>("tmr/contribution", x))
        .filter((x) => field(x, "runId") === run.runId && field(x, "stageId") === stageId)
        .map((x) => ctx.contract.read<Json>("json", field(x, "content")));
    }
  const request = {
    modelRef: participant.modelRef,
    messages: [
      {
        role: "system" as const,
        content: (run.stagePrompts?.[stage.kind] ?? fail("internal", "TMR stage prompt missing")).replace(
          "{{roleLabel}}",
          participant.roleLabel,
        ),
      },
      {
        role: "user" as const,
        content: canonical({
          question: run.question,
          criteria: run.criteria,
          context: stageContext(stage, snapshot, prior),
        }),
      },
    ],
    output: { kind: "json" as const, schema: stage.outputSchema, name: "tmr-contribution" },
    maxOutputTokens: 1600,
    ...(participant.temperature === undefined ? {} : { temperature: participant.temperature }),
  };
  const settings = ctx.settings(),
    configured = field(field(settings, "models"), participant.modelRef),
    model = ctx.contract.read<ProviderModel>("provider-model", configured),
    amount = estimateReservationMicros(request satisfies ModelRequest, model);
  ctx.budgets.reserve(reservationId, run.runId, amount);
  let output: Json | undefined;
  const controller = new AbortController(),
    calls = activeCalls.get(run.runId) ?? new Set<AbortController>();
  calls.add(controller);
  activeCalls.set(run.runId, calls);
  try {
    for await (const event of ctx.gateway.call(request, {
      reservationId,
      idempotencyKey: key,
      signal: controller.signal,
    })) {
      if (event.type === "output") output = ctx.contract.read<Json>("json", event.json);
      if (event.type === "error") fail("unavailable", "TMR model contribution failed");
    }
  } finally {
    calls.delete(controller);
    if (calls.size === 0) activeCalls.delete(run.runId);
  }
  if (output === undefined) fail("invalid", "TMR model returned no structured contribution");
  return output;
}
function resume(ctx: ModuleContext, id: string): Json {
  const run = getRun(ctx, id);
  if (!["interrupted", "partial", "failed", "limit_reached"].includes(run.status))
    fail("conflict", "TMR run cannot resume");
  const index = firstMissingStage(ctx, run);
  if (index >= 0) {
    const resumed = queuedRun(run);
    saveRun(ctx, resumed, true);
    enqueue(ctx, resumed, index);
  }
  return { runId: id, status: index >= 0 ? "queued" : run.status };
}
function firstMissingStage(ctx: ModuleContext, run: Run): number {
  return run.processSpec.stages.findIndex((stage) =>
    assignedParticipants(run, stage).some(
      (participantId) => !ctx.repository.feedback("tmr-contribution", run.runId + ":" + stage.id + ":" + participantId),
    ),
  );
}
function cancelRun(ctx: ModuleContext, id: string, activeCalls: Map<string, Set<AbortController>>): Json {
  const run = getRun(ctx, id);
  for (const controller of activeCalls.get(id) ?? []) controller.abort();
  if (!terminal(run.status)) finish(ctx, { ...run, status: "cancelled", outcome: "cancelled" });
  return { runId: id, status: terminal(run.status) ? run.status : "cancelled" };
}
function getRun(ctx: ModuleContext, id: string): Run {
  const x = ctx.repository.feedback("tmr-run", id);
  if (!x) fail("not_found", "TMR run not found");
  return ctx.contract.read<Run>("tmr/run", x);
}
function maybeRun(ctx: ModuleContext, id: string): Run | undefined {
  const x = ctx.repository.feedback("tmr-run", id);
  return x ? ctx.contract.read<Run>("tmr/run", x) : undefined;
}
function listRuns(ctx: ModuleContext): Run[] {
  return ctx.repository
    .feedbackList("tmr-run")
    .map((x) => ctx.contract.read<Run>("tmr/run", x))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function terminal(s: string): boolean {
  return ["completed", "partial", "limit_reached", "failed", "cancelled", "interrupted"].includes(s);
}
function queuedRun(run: Run): Run {
  const withoutOutcome = { ...run };
  delete withoutOutcome.outcome;
  return { ...withoutOutcome, status: "queued" };
}
function holdsLease(ctx: ModuleContext, job: import("../../../contract/src/index.js").Job): boolean {
  return ctx.repository
    .jobs()
    .some((current) => current.id === job.id && current.state === "leased" && current.attempts === job.attempts);
}
function recordProgress(ctx: ModuleContext, runId: string, eventType: string, details: Record<string, Json>): void {
  const eventId = ctx.ids.next("tmr_event_"),
    ts = ctx.clock.now(),
    event = { eventId, runId, eventType, ...details, ts };
  ctx.repository.saveFeedback("tmr-event", eventId, ctx.contract.read<Json>("json", event));
  ctx.appendEvent({
    ts,
    type: "tmr.ProcessProgress",
    entity: { kind: "tmr_run", id: runId },
    payload: ctx.contract.read<Json>("json", { runId, eventType, ...details }),
  });
}
function field(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null ? Reflect.get(v, k) : undefined;
}
function str(v: unknown, k: string): string {
  const x = field(v, k);
  if (typeof x !== "string") fail("invalid", "Expected " + k);
  return x;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function loadStagePrompt(kind: string): string {
  return readFileSync(new URL("./prompts/" + kind + ".md", import.meta.url), "utf8");
}
