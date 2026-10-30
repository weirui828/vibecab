import { createHash } from "node:crypto";
import {
  fail,
  type CallContext,
  type CommandEnvelope,
  type Json,
  type QueryEnvelope,
} from "../../../contract/src/index.js";
import type { EngineModule, ModuleContext } from "../kernel/module-registry.js";
import { canonical } from "../kernel/canonical.js";
import type { FeedbackPort } from "../feedback/index.js";
import type { UpdatesPort } from "../updates/index.js";
import type { TmrPort } from "../tmr/index.js";

export type IntegrationPorts = { feedback: FeedbackPort; updates: UpdatesPort; tmr: TmrPort };
const commands = ["vc.RequestReview", "vc.ConvertSuggestedReview"],
  queries = ["vc.Findings", "vc.ReviewReport"];

export function integrationModule(ports: IntegrationPorts): EngineModule {
  return {
    name: "integration",
    commands: Object.fromEntries(
      commands.map((name) => [
        name,
        (ctx, call, cmd) =>
          name === "vc.RequestReview" ? requestReview(ctx, call, cmd, ports) : convertDraft(ctx, call, cmd, ports),
      ]),
    ),
    queries: Object.fromEntries(
      queries.map((name) => [name, (ctx, _call, query) => queryReview(ctx, name, query, ports)]),
    ),
    jobKinds: {
      "integration.review.submit": { onLostLease: "rerun", run: (ctx, job) => submitJob(ctx, job, ports) },
      "integration.review.poll": {
        onLostLease: "rerun",
        run: (ctx, job) => pollJob(ctx, job, ports),
      },
    },
  };
}

function convertDraft(ctx: ModuleContext, call: CallContext, command: CommandEnvelope, ports: IntegrationPorts): Json {
  if (call.principal.kind !== "human") fail("forbidden", "Only a person can approve a review draft");
  const p = ctx.contract.read<Record<string, Json>>(
      "operations/vc.ConvertSuggestedReview",
      command.payload,
      "#/properties/payload",
    ),
    draft = read(ctx, "json", ctx.repository.feedback("review-draft", str(p.draftId))),
    sessionId = str(field(draft, "sessionId")),
    elementIds = strings(field(draft, "elementIds"));
  if (!elementIds.length) fail("invalid", "Review draft has no suggested elements");
  return requestReview(
    ctx,
    call,
    {
      ...command,
      type: "vc.RequestReview",
      payload: {
        sessionId,
        question: str(p.question),
        elementRefs: arr(p.elementRefs),
        ...(p.criteria ? { criteria: arr(p.criteria) } : {}),
        preset: str(p.preset),
        ...(p.participants ? { participants: arr(p.participants) } : {}),
        limits: p.limits ?? fail("invalid", "Review limits are required"),
        mode: str(p.mode),
      },
    },
    ports,
  );
}

function requestReview(ctx: ModuleContext, call: CallContext, command: CommandEnvelope, ports: IntegrationPorts): Json {
  const p = ctx.contract.read<Record<string, Json>>(
    "operations/vc.RequestReview",
    command.payload,
    "#/properties/payload",
  );
  if (call.principal.kind !== "human") fail("forbidden", "Only a person can request a review");
  if (field(p, "preset") !== "independent-review") fail("invalid", "Unsupported TMR review preset");
  const sessionId = str(p.sessionId),
    capture = ports.feedback.captureReview(ctx, {
      sessionId,
      ...(optStr(p.threadId) ? { threadId: optStr(p.threadId) } : {}),
      elementRefs: arr(p.elementRefs),
      ...(p.commentIds ? { commentIds: strings(p.commentIds) } : {}),
    });
  const reviewRequestId = ctx.ids.next("review_"),
    threadId = capture.threadId,
    items = capture.items,
    sourceMap = capture.sourceMap;
  const snapshotId = createHash("sha256").update(canonical(items)).digest("hex"),
    request = ctx.contract.read<Json>("review-request", {
      reviewRequestId,
      sessionId,
      threadId,
      snapshotId,
      sourceMap,
      requestedBy: "human",
      cursor: 0,
      status: "queued",
      createdAt: ctx.clock.now(),
    });
  ctx.repository.saveFeedback("review-request", reviewRequestId, request);
  ctx.repository.saveFeedback("review-snapshot", reviewRequestId, ctx.contract.read<Json>("json", items));
  ctx.enqueue(
    "integration.review.submit",
    reviewRequestId,
    ctx.contract.read<Json>("json", {
      reviewRequestId,
      question: str(p.question),
      items,
      criteria: arr(p.criteria),
      participants: p.participants ?? [],
      limits: p.limits,
      mode: p.mode,
      preset: p.preset,
    }),
    ctx.clock.now(),
  );
  ctx.appendEvent({
    ts: ctx.clock.now(),
    type: "vc.ReviewRequested",
    entity: { kind: "review", id: reviewRequestId },
    payload: ctx.contract.read<Json>("json", { reviewRequestId, sessionId }),
  });
  return { reviewRequestId, status: "queued" };
}

async function submitJob(
  ctx: ModuleContext,
  job: import("../../../contract/src/index.js").Job,
  ports: IntegrationPorts,
): Promise<void> {
  const p = obj(job.payload),
    reviewRequestId = str(p.reviewRequestId);
  const existing = ctx.repository.feedback("review-request", reviewRequestId);
  if (!existing || field(existing, "runId")) return;
  const participantInput = arr(p.participants),
    participants = participantInput.length ? participantInput : defaultParticipants(ctx);
  const participantIds = participants.map((x) => str(field(x, "participantId")) ?? "");
  if (!participantIds.length) fail("invalid", "A review requires at least one participant");
  const processSpec = independentReview(participantIds),
    result = await ctx.mutate(() =>
      ports.tmr.submit(ctx, {
        requestId: reviewRequestId,
        question: str(p.question) ?? "Review selected materials",
        intendedUse: "VibeCab review",
        items: arr(p.items),
        criteria: arr(p.criteria),
        processSpec: ctx.contract.read<Json>("tmr/process-spec", processSpec),
        participants: ctx.contract.read<Json>("json", participants),
        limits: ctx.contract.read<Json>("json", p.limits),
        mode: str(p.mode),
      }),
    ),
    runId = str(field(result, "runId"));
  await ctx.mutate(() => {
    const latest = ctx.repository.feedback("review-request", reviewRequestId);
    if (!latest) return;
    ctx.repository.saveFeedback(
      "review-request",
      reviewRequestId,
      ctx.contract.read<Json>("review-request", { ...obj(latest), runId, status: "running" }),
    );
    ctx.enqueue(
      "integration.review.poll",
      "poll:" + reviewRequestId,
      ctx.contract.read<Json>("json", { reviewRequestId }),
      ctx.clock.now(),
    );
  });
}

async function pollJob(
  ctx: ModuleContext,
  job: import("../../../contract/src/index.js").Job,
  ports: IntegrationPorts,
): Promise<void> {
  const reviewRequestId = str(field(job.payload, "reviewRequestId")),
    raw = ctx.repository.feedback("review-request", reviewRequestId);
  if (!raw || !field(raw, "runId")) return;
  const req = read(ctx, "review-request", raw),
    run = ports.tmr.run(ctx, str(field(req, "runId"))!),
    storedEvents = ports.tmr.events(ctx, run.runId, Number(field(req, "cursor")) || 0);
  await ctx.mutate(() => {
    for (const event of storedEvents.events) {
      ctx.appendEvent({
        ts: str(field(event, "ts")) ?? ctx.clock.now(),
        type: "vc.ReviewProgress",
        entity: { kind: "review", id: reviewRequestId },
        payload: ctx.contract.read<Json>("json", {
          reviewRequestId,
          runId: run.runId,
          eventType: optStr(field(event, "eventType")) ?? "progress",
        }),
      });
    }
    const cursor = storedEvents.cursor;
    const updated = { ...obj(req), cursor, status: terminal(run.status) ? "completed" : "running" };
    ctx.repository.saveFeedback("review-request", reviewRequestId, ctx.contract.read<Json>("review-request", updated));
    if (!terminal(run.status)) {
      const notBefore = new Date(Date.parse(ctx.clock.now()) + 1000).toISOString();
      ctx.enqueue(
        "integration.review.poll",
        "poll:" + reviewRequestId + ":" + notBefore,
        ctx.contract.read<Json>("json", {
          reviewRequestId,
          notBefore,
        }),
        ctx.clock.now(),
      );
    } else deliverReport(ctx, req, run.runId, ports);
  });
}

function deliverReport(ctx: ModuleContext, req: Json, runId: string, ports: IntegrationPorts): void {
  if (ctx.repository.feedback("review-delivery", runId)) return;
  let report: Json;
  try {
    report = ports.tmr.report(ctx, runId);
  } catch {
    return;
  }
  const sessionId = str(field(req, "sessionId"))!,
    threadId = str(field(req, "threadId"))!,
    now = ctx.clock.now();
  ports.feedback.postReviewReport(ctx, { sessionId, threadId, runId });
  const findings = arr(field(report, "findings")),
    snapshot = arr(ctx.repository.feedback("review-snapshot", str(field(req, "reviewRequestId"))));
  for (const finding of findings) {
    const firstRef = arr(field(finding, "refs"))[0],
      itemId = str(field(firstRef, "itemId")),
      sourceItem = snapshot.find((item) => field(item, "itemId") === itemId),
      source = obj(field(req, "sourceMap")),
      map = itemId ? field(source, itemId) : undefined;
    const findingSource = map
      ? {
          artifactId: str(field(map, "artifactId")),
          version: Number(field(map, "version")),
          elementId: str(field(map, "elementId")),
          elementHash: str(field(map, "elementHash")),
          content: ctx.contract.read<Json>("json", field(sourceItem, "content")),
        }
      : undefined;
    ports.feedback.createFindingItem(ctx, {
      sessionId,
      threadId,
      runId,
      finding,
      ...(findingSource ? { source: findingSource } : {}),
    });
  }
  ctx.appendEvent({
    ts: now,
    type: "vc.ReportArrived",
    entity: { kind: "review", id: str(field(req, "reviewRequestId"))! },
    payload: ctx.contract.read<Json>("json", { reviewRequestId: field(req, "reviewRequestId"), runId }),
  });
  ctx.repository.saveFeedback("review-delivery", runId, ctx.contract.read<Json>("json", { deliveredAt: now }));
}

function queryReview(ctx: ModuleContext, name: string, query: QueryEnvelope, ports: IntegrationPorts): Json {
  const p = ctx.contract.read<Record<string, Json>>("operations/" + name, query.args, "#/properties/payload"),
    id = str(p.reviewRequestId),
    req = read(ctx, "review-request", ctx.repository.feedback("review-request", id)),
    runId = requestRunId(ctx, req, id, ports);
  if (name === "vc.ReviewReport") return ports.tmr.report(ctx, runId);
  let report: Json;
  try {
    report = ports.tmr.report(ctx, runId);
  } catch {
    return [];
  }
  const snapshot = arr(ctx.repository.feedback("review-snapshot", id)),
    sourceMap = obj(field(req, "sourceMap")),
    result: Json[] = [];
  for (const finding of arr(field(report, "findings"))) {
    const refs = arr(field(finding, "refs")),
      itemId = str(field(refs[0], "itemId")),
      map = itemId ? field(sourceMap, itemId) : undefined;
    if (!map) {
      result.push(ctx.contract.read<Json>("json", { finding, applicability: "not_located" }));
      continue;
    }
    const artifactId = str(field(map, "artifactId")),
      elementId = str(field(map, "elementId"))!,
      reviewed = snapshot.find((item) => field(item, "itemId") === itemId),
      head = ports.updates.findingHead(ctx, {
        artifactId,
        elementId,
        elementHash: str(field(map, "elementHash")),
      });
    result.push(
      ctx.contract.read<Json>("json", {
        finding,
        applicability: head.applicability,
        reviewedContent: field(field(reviewed, "content"), "text") ?? "",
        ...(head.currentContent ? { currentContent: head.currentContent } : {}),
      }),
    );
  }
  return ctx.contract.read<Json>("json", result);
}

function requestRunId(ctx: ModuleContext, request: Json, requestId: string, ports: IntegrationPorts): string {
  const saved = optStr(field(request, "runId"));
  if (saved) return saved;
  const submitted = ports.tmr.findRunByRequestId(ctx, requestId);
  if (!submitted) fail("unavailable", "Review run has not been submitted yet", { retryable: true });
  return submitted.runId;
}

function defaultParticipants(ctx: ModuleContext): Json[] {
  const models = field(ctx.settings(), "models"),
    refs = models && typeof models === "object" ? Object.keys(models) : [],
    modelRef = refs[0] ?? "demo";
  return [
    {
      participantId: "reviewer-1",
      roleLabel: "Independent reviewer",
      modelRef,
      systemPromptHash: createHash("sha256").update("vibecab-reviewer").digest("hex"),
    },
  ];
}
function independentReview(ids: string[]) {
  return {
    version: 1,
    maxStages: 2,
    onMissingContribution: "proceed_disclosed",
    stages: [
      {
        id: "assess",
        kind: "assess",
        participants: "all",
        inputs: ["snapshot"],
        outputSchema: { type: "object" },
        quorum: 1,
      },
      {
        id: "synthesize",
        kind: "synthesize",
        participants: [ids[0]],
        inputs: ["snapshot", "stage:assess"],
        outputSchema: { type: "object" },
        quorum: 1,
      },
    ],
  };
}
function terminal(status: string): boolean {
  return ["completed", "partial", "limit_reached", "failed", "cancelled", "interrupted"].includes(status);
}
function read(ctx: ModuleContext, schema: string, v: unknown): Json {
  if (v === undefined) fail("not_found", "Review record not found");
  return ctx.contract.read<Json>(schema, v);
}
function obj(v: unknown): Record<string, Json> {
  return isRecord(v) ? v : {};
}
function arr(v: unknown): Json[] {
  return Array.isArray(v) && v.every(isJson) ? v : [];
}
function field(v: unknown, k: string): unknown {
  return v && typeof v === "object" ? Reflect.get(v, k) : undefined;
}
function str(v: unknown): string {
  if (typeof v !== "string") fail("invalid", "Review field must be a string");
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function strings(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string");
}
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
