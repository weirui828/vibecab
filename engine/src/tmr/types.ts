import type { ProcessSpec } from "./process.js";

export type Participant = {
  participantId: string;
  roleLabel: string;
  modelRef: string;
  systemPromptHash: string;
  temperature?: number;
};

export type Run = {
  runId: string;
  requestId: string;
  payloadHash: string;
  question: string;
  intendedUse?: string;
  snapshotId: string;
  criteria: string[];
  processSpec: ProcessSpec;
  processHash: string;
  participants: Participant[];
  limits: { spendMicros: number; autoResume?: boolean };
  mode: "live" | "demo";
  status: string;
  outcome?: string;
  coverage?: import("../../../contract/src/index.js").Json;
  rerunOf?: string;
  createdAt: string;
};
