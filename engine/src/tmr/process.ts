import { createHash } from "node:crypto";
import { fail, type Json, type JsonSchema } from "../../../contract/src/index.js";
import { canonical } from "../kernel/canonical.js";

export type StageKind = "assess" | "critique" | "revise" | "debate_round" | "synthesize";
export interface ProcessStage {
  id: string;
  kind: StageKind;
  participants: string[] | "all";
  inputs: string[];
  outputSchema: JsonSchema;
  quorum: number;
}
export interface ProcessSpec {
  version: number;
  stages: ProcessStage[];
  onMissingContribution: "fail" | "proceed_disclosed" | { retry: number; then: "fail" | "proceed_disclosed" };
  maxStages: number;
}

export function validateProcess(value: ProcessSpec, participantIds: string[]): ProcessSpec {
  if (!Number.isSafeInteger(value.version) || value.version < 1) fail("invalid", "Invalid TMR process version");
  if (!Number.isSafeInteger(value.maxStages) || value.maxStages < 1 || value.stages.length > value.maxStages)
    fail("invalid", "TMR process exceeds maxStages");
  if (
    !value.stages.length ||
    value.stages.at(-1)?.kind !== "synthesize" ||
    value.stages.filter((stage) => stage.kind === "synthesize").length !== 1
  )
    fail("invalid", "TMR process requires exactly one final synthesize stage");
  const seen = new Set<string>();
  for (const stage of value.stages) {
    if (!stage.id || seen.has(stage.id)) fail("invalid", "TMR stage ids must be unique");
    if (!Number.isSafeInteger(stage.quorum) || stage.quorum < 1) fail("invalid", "TMR stage quorum must be positive");
    const assigned = stage.participants === "all" ? participantIds : stage.participants;
    if (!assigned.length || assigned.some((id) => !participantIds.includes(id)))
      fail("invalid", "TMR stage references an unknown participant");
    if (stage.kind === "assess" && stage.inputs.some((input) => input !== "snapshot"))
      fail("invalid", "Independent assessment stages can only receive the input snapshot");
    for (const input of stage.inputs) {
      if (input === "snapshot") continue;
      const match = /^stage:(.+)$/.exec(input);
      if (!match || !seen.has(match[1]!)) fail("invalid", "TMR stage input is a forward or unknown reference");
    }
    seen.add(stage.id);
  }
  return value;
}

export function snapshotId(items: Json): string {
  return createHash("sha256").update(canonical(items)).digest("hex");
}

export function stageContext(stage: ProcessStage, snapshot: Json, prior: Record<string, Json[]>): Json {
  const inputs: Record<string, Json> = {};
  for (const input of stage.inputs) {
    if (input === "snapshot") inputs.snapshot = snapshot;
    else {
      const stageId = input.slice("stage:".length);
      inputs[stageId] = prior[stageId] ?? [];
    }
  }
  return inputs;
}
