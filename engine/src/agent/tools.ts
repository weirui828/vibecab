import type { Contract, JsonSchema } from "../../../contract/src/index.js";

export const replyToolNames = ["read_elements", "outline", "search", "reply", "suggest_review"] as const;

export function replyToolSchemas(contract: Contract): Map<string, JsonSchema> {
  return new Map(replyToolNames.map((name) => [name, contract.schema(`agent-tools/${name}`)]));
}
