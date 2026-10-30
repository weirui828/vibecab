import type { ProcessSpec } from "../process.js";
import { fail } from "../../../../contract/src/index.js";

export function independentReviewPreset(participantIds: string[]): ProcessSpec {
  const first = participantIds[0];
  if (!first) fail("invalid", "independent-review requires at least one participant");
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
        participants: [first],
        inputs: ["snapshot", "stage:assess"],
        outputSchema: { type: "object" },
        quorum: 1,
      },
    ],
  };
}
