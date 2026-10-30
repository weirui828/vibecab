import type { Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import type { Run } from "./types.js";

export function finish(ctx: ModuleContext, run: Run): void {
  const contributions = ctx.repository
      .feedbackList("tmr-contribution")
      .map((x) => ctx.contract.read<Json>("tmr/contribution", x))
      .filter((x) => field(x, "runId") === run.runId),
    expected = run.processSpec.stages.reduce(
      (n, s) => n + (s.participants === "all" ? run.participants.length : s.participants.length),
      0,
    ),
    stages = run.processSpec.stages.map((stage) => {
      const expectedParticipants =
          stage.participants === "all"
            ? run.participants.map((participant) => participant.participantId)
            : stage.participants,
        actualParticipants = contributions
          .filter((contribution) => field(contribution, "stageId") === stage.id)
          .map((contribution) => field(contribution, "participantId"))
          .filter((participantId): participantId is string => typeof participantId === "string");
      return {
        stageId: stage.id,
        expected: expectedParticipants.length,
        actual: actualParticipants.length,
        missing: expectedParticipants.length - actualParticipants.length,
        expectedParticipants,
        actualParticipants,
        missingParticipants: expectedParticipants.filter((id) => !actualParticipants.includes(id)),
      };
    }),
    coverage = {
      expected,
      actual: contributions.length,
      missing: Math.max(0, expected - contributions.length),
      stages,
    },
    last = field(contributions.at(-1), "content"),
    outcome = run.outcome ?? (coverage.missing > 0 ? "partial" : "completed"),
    snapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
    resolved = resolveFindings(ctx, run, array(field(last, "findings")), contributions),
    agreementCounts = contributions.reduce<Record<string, number>>((counts, contribution) => {
      const position = field(field(contribution, "content"), "position");
      if (typeof position === "string") counts[position] = (counts[position] ?? 0) + 1;
      return counts;
    }, {});
  const report = ctx.contract.read<Json>("tmr/report", {
    runId: run.runId,
    mode: run.mode,
    scope: {
      question: run.question,
      intendedUse: run.intendedUse ?? null,
      snapshotId: run.snapshotId,
      criteria: run.criteria,
    },
    recommendation: field(last, "recommendation") ?? last ?? {},
    alignment: objectArray(field(last, "alignment")),
    dissent: objectArray(field(last, "dissent")),
    findings: resolved.findings,
    inputMaterials: array(field(snapshot, "items")),
    evidenceAndAttribution: contributions.map((c) => ({
      contributionId: field(c, "contributionId"),
      participantId: field(c, "participantId"),
      content: field(c, "content"),
    })),
    missingInformation: [
      ...stringArray(field(last, "missingInformation")),
      ...stages.flatMap((stage) =>
        stage.missingParticipants.map((id) => stage.stageId + ": missing contribution from " + id),
      ),
      ...(resolved.invalidCount > 0
        ? [resolved.invalidCount + " finding(s) did not match the report schema and were omitted"]
        : []),
    ],
    coverage,
    outcome,
    inspectionReferences: { runId: run.runId },
    statistics: { contributions: contributions.length, mode: run.mode, explicitPositions: agreementCounts },
  });
  ctx.repository.saveFeedback("tmr-report", run.runId, report);
  saveRun(ctx, { ...run, status: outcome, outcome, coverage });
}

function resolveFindings(
  ctx: ModuleContext,
  run: Run,
  rawFindings: Json[],
  contributions: Json[],
): { findings: Json[]; invalidCount: number } {
  const snapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
    itemIds = new Set(array(field(snapshot, "items")).map((item) => field(item, "itemId"))),
    contributionIds = new Set(contributions.map((item) => field(item, "contributionId"))),
    findings: Json[] = [];
  let invalidCount = 0;
  for (const raw of rawFindings) {
    try {
      const finding = ctx.contract.read<Record<string, Json>>("tmr/finding", raw),
        refs = array(finding.refs),
        unresolved = refs.some((ref) => {
          if (isObject(ref) && typeof field(ref, "itemId") === "string") return !itemIds.has(field(ref, "itemId"));
          if (isObject(ref) && typeof field(ref, "contributionId") === "string")
            return !contributionIds.has(field(ref, "contributionId"));
          return true;
        });
      findings.push(
        ctx.contract.read<Json>("tmr/finding", { ...finding, ...(unresolved ? { unresolved_reference: true } : {}) }),
      );
    } catch {
      invalidCount++;
    }
  }
  return { findings, invalidCount };
}

export function saveRun(ctx: ModuleContext, run: Run): void {
  const checked = ctx.contract.read<Run>("tmr/run", run);
  ctx.repository.saveFeedback("tmr-run", checked.runId, ctx.contract.read<Json>("json", checked));
  const event = {
    eventId: ctx.ids.next("tmr_event_"),
    runId: checked.runId,
    status: checked.status,
    ts: ctx.clock.now(),
  };
  ctx.repository.saveFeedback("tmr-event", event.eventId, ctx.contract.read<Json>("json", event));
  ctx.appendEvent({
    ts: event.ts,
    type: "tmr.RunChanged",
    entity: { kind: "tmr_run", id: checked.runId },
    payload: ctx.contract.read<Json>("json", { runId: checked.runId, status: checked.status }),
  });
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function array(value: unknown): Json[] {
  return Array.isArray(value) ? value : [];
}
function stringArray(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}
function objectArray(value: unknown): Json[] {
  return array(value).filter(isObject);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
