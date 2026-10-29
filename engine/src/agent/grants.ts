import { Contract, fail } from "../../../contract/src/index.js";
import type { CallContext, Json } from "../../../contract/src/index.js";
import type { IdGenerator } from "../kernel/dependencies.js";
import type { Repository } from "../storage/repository.js";
import type { Clock } from "../kernel/dependencies.js";

export function createGrant(
  store: Repository,
  contract: Contract,
  ids: IdGenerator,
  principal: CallContext["principal"],
  raw: unknown,
): { grantId: string } {
  if (principal.kind !== "human") fail("forbidden", "Grant management requires a human principal");
  const payload = contract.read<{
    scope: { sessionIds?: string[]; artifactIds?: string[] };
    capabilities: string[];
    limits: { spendMicros?: number; maxReviews?: number };
    expiresAt?: string;
  }>("operations/vc.CreateGrant", raw, "#/properties/payload");
  const grantId = ids.next("grant_");
  store.saveFeedback("grant", grantId, contract.read<Json>("grant", { grantId, ...payload }));
  return { grantId };
}

export function revokeGrant(
  store: Repository,
  contract: Contract,
  clock: Clock,
  principal: CallContext["principal"],
  raw: unknown,
): { grantId: string } {
  if (principal.kind !== "human") fail("forbidden", "Grant management requires a human principal");
  const payload = contract.read<{ grantId: string }>("operations/vc.RevokeGrant", raw, "#/properties/payload");
  const grant = store.feedback("grant", payload.grantId);
  if (!grant) fail("not_found", "Grant not found");
  const parsed = contract.read<Record<string, Json>>("grant", grant);
  store.saveFeedback("grant", payload.grantId, contract.read<Json>("grant", { ...parsed, revokedAt: clock.now() }));
  return payload;
}
