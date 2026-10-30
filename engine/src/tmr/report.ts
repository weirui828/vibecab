import type { Json } from "../../../contract/src/index.js";
import { canonical } from "../kernel/canonical.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import type { Run } from "./types.js";

export function finish(ctx: ModuleContext, run: Run): void {
  const rawCurrent = ctx.repository.feedback("tmr-run", run.runId);
  if (rawCurrent) {
    const current = ctx.contract.read<Run>("tmr/run", rawCurrent);
    if (isTerminal(current.status)) return;
    run = { ...current, status: run.status, ...(run.outcome ? { outcome: run.outcome } : {}) };
  }
  const contributions = ctx.repository
      .feedbackList("tmr-contribution")
      .map((x) => ctx.contract.read<Json>("tmr/contribution", x))
      .filter((x) => field(x, "runId") === run.runId)
      .sort((a, b) => contributionOrder(run, a) - contributionOrder(run, b)),
    expected = run.processSpec.stages.reduce(
      (n, s) => n + (s.participants === "all" ? run.participants.length : s.participants.length),
      0,
    ),
    stages = run.processSpec.stages.map((stage) => {
      const expectedParticipants =
          stage.participants === "all"
            ? run.participants.map((participant) => participant.participantId)
            : stage.participants,
        present = new Set(
          contributions
            .filter((contribution) => field(contribution, "stageId") === stage.id)
            .map((contribution) => field(contribution, "participantId"))
            .filter((participantId): participantId is string => typeof participantId === "string"),
        ),
        actualParticipants = expectedParticipants.filter((participantId) => present.has(participantId));
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
    synthesis = run.processSpec.stages.find((stage) => stage.kind === "synthesize"),
    synthesisAssigned = synthesis
      ? synthesis.participants === "all"
        ? run.participants.map((participant) => participant.participantId)
        : synthesis.participants
      : [],
    synthesisContribution = synthesisAssigned
      .map((participantId) =>
        contributions.find(
          (contribution) =>
            field(contribution, "stageId") === synthesis?.id && field(contribution, "participantId") === participantId,
        ),
      )
      .find((contribution) => contribution !== undefined),
    synthesisContent = field(synthesisContribution, "content"),
    outcome = run.outcome ?? (coverage.missing > 0 ? "partial" : "completed"),
    snapshot = ctx.repository.feedback("tmr-snapshot", run.snapshotId),
    resolved = resolveFindings(ctx, run, array(field(synthesisContent, "findings")), contributions),
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
    recommendation: field(synthesisContent, "recommendation") ?? null,
    alignment: objectArray(field(synthesisContent, "alignment")),
    dissent: objectArray(field(synthesisContent, "dissent")),
    findings: resolved.findings,
    inputMaterials: array(field(snapshot, "items")),
    evidenceAndAttribution: contributions.map((c) => ({
      contributionId: field(c, "contributionId"),
      participantId: field(c, "participantId"),
      content: field(c, "content"),
    })),
    missingInformation: [
      ...stringArray(field(synthesisContent, "missingInformation")),
      ...(!synthesisContribution
        ? ["No synthesis contribution was recorded; recommendation and findings are unavailable"]
        : []),
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

export function saveRun(ctx: ModuleContext, run: Run, allowTerminalTransition = false): void {
  const existing = ctx.repository.feedback("tmr-run", run.runId);
  if (existing) {
    const current = ctx.contract.read<Run>("tmr/run", existing);
    if (isTerminal(current.status) && !allowTerminalTransition) return;
  }
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

export function markdownReport(report: Json): string {
  const scope = field(report, "scope"),
    recommendation = field(report, "recommendation"),
    alignment = array(field(report, "alignment")),
    dissent = array(field(report, "dissent")),
    coverage = field(report, "coverage"),
    stats = field(report, "statistics"),
    lines = [
      "# TMR report",
      "",
      "## Scope",
      "",
      "- Question: " + scalar(field(scope, "question")),
      "- Intended use: " + scalar(field(scope, "intendedUse")),
      "- Outcome: " + scalar(field(report, "outcome")),
      "- Mode: " + scalar(field(report, "mode")),
      "- Snapshot: " + scalar(field(scope, "snapshotId")),
      "- Criteria: " + scalar(field(scope, "criteria")),
      "",
      "## Recommendation",
      "",
      ...renderValue(recommendation),
      "",
      "## Findings",
      "",
    ];
  const findings = array(field(report, "findings"));
  if (!findings.length) lines.push("No findings.");
  for (const finding of findings) {
    lines.push(
      "### " + scalar(field(finding, "concern")),
      "",
      "- Severity: " + scalar(field(finding, "severity") ?? "unspecified"),
      "- Rationale: " + scalar(field(finding, "rationale")),
    );
    const consequence = field(finding, "consequence"),
      suggestion = field(finding, "suggestion");
    if (consequence !== undefined) lines.push("- Consequence: " + scalar(consequence));
    if (suggestion !== undefined) lines.push("- Suggestion: " + scalar(suggestion));
    lines.push("- References: " + array(field(finding, "refs")).map(scalar).join(", "));
    lines.push("");
  }
  lines.push(
    "## Alignment",
    "",
    ...(alignment.length ? alignment.map((item) => "- " + scalar(item)) : ["None recorded."]),
  );
  lines.push(
    "",
    "## Dissent",
    "",
    ...(dissent.length ? dissent.map((item) => "- " + scalar(item)) : ["None recorded."]),
  );
  lines.push("", "## Coverage", "", "| Stage | Expected | Actual | Missing |", "| --- | ---: | ---: | ---: |");
  for (const stage of array(field(coverage, "stages")))
    lines.push(
      "| " +
        scalar(field(stage, "stageId")) +
        " | " +
        scalar(field(stage, "expected")) +
        " | " +
        scalar(field(stage, "actual")) +
        " | " +
        scalar(field(stage, "missing")) +
        " |",
    );
  lines.push(
    "",
    "## Missing information",
    "",
    ...(stringArray(field(report, "missingInformation")).length
      ? stringArray(field(report, "missingInformation")).map((item) => "- " + item)
      : ["None recorded."]),
    "",
    "## Evidence and attribution",
    "",
  );
  const evidence = array(field(report, "evidenceAndAttribution"));
  if (!evidence.length) lines.push("No contributions recorded.");
  for (const item of evidence) {
    lines.push(
      "- " +
        scalar(field(item, "participantId")) +
        " (" +
        scalar(field(item, "contributionId")) +
        "): " +
        scalar(field(item, "content")),
    );
  }
  lines.push("", "## Input materials", "");
  const materials = array(field(report, "inputMaterials"));
  if (!materials.length) lines.push("No input materials recorded.");
  for (const item of materials)
    lines.push(
      "- " +
        scalar(field(item, "itemId")) +
        " (" +
        scalar(field(item, "kind")) +
        "): " +
        scalar(field(item, "source")) +
        " — " +
        scalar(field(item, "content")),
    );
  lines.push("", "## Inspection references", "", ...renderValue(field(report, "inspectionReferences")));
  lines.push("", "## Statistics", "", ...renderValue(stats));
  return lines.join("\n");
}

function renderValue(value: unknown): string[] {
  if (value === null || value === undefined) return ["Unavailable."];
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || Array.isArray(value)) return [scalar(value)];
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, item]) => "- **" + key + "**: " + scalar(item));
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value.replaceAll("\n", " ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonical(value);
}

function isTerminal(status: string): boolean {
  return ["completed", "partial", "limit_reached", "failed", "cancelled", "interrupted"].includes(status);
}

function contributionOrder(run: Run, contribution: Json): number {
  const stageId = field(contribution, "stageId"),
    participantId = field(contribution, "participantId"),
    stageIndex = run.processSpec.stages.findIndex((stage) => stage.id === stageId),
    stage = run.processSpec.stages[stageIndex],
    participants = stage
      ? stage.participants === "all"
        ? run.participants.map((participant) => participant.participantId)
        : stage.participants
      : [],
    participantIndex = participants.indexOf(typeof participantId === "string" ? participantId : "");
  return stageIndex * 1_000_000 + participantIndex;
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
