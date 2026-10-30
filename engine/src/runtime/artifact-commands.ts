import type { Json } from "../../../contract/src/index.js";
import type { Repository } from "../storage/repository.js";
import type { ContractValidator } from "../kernel/module-registry.js";

export function renameArtifact(
  store: Repository,
  contract: ContractValidator,
  now: () => string,
  raw: unknown,
): { artifactId: string; title: string } {
  const payload = contract.read<{ artifactId: string; title: string }>(
    "operations/vc.RenameArtifact",
    raw,
    "#/properties/payload",
  );
  const updated = store.renameArtifact(payload.artifactId, payload.title, now());
  store.appendEvent({
    ts: now(),
    type: "vc.ArtifactRenamed",
    entity: { kind: "artifact", id: payload.artifactId },
    payload: contract.read<Json>("events/vc.ArtifactRenamed", payload),
  });
  return { artifactId: updated.artifactId, title: updated.title };
}
