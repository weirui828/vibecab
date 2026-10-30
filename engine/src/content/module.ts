import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";

export function contentModule(host: EngineModuleHost) {
  return createModule(
    "content",
    host,
    [
      "vc.CreateArtifact",
      "vc.ImportContent",
      "vc.RestoreVersion",
      "vc.HoldElement",
      "vc.SaveElement",
      "vc.ReleaseHold",
      "vc.RenameArtifact",
    ],
    ["vc.Artifact", "vc.Artifacts", "vc.Outline", "vc.Elements", "vc.Versions", "vc.Diff", "vc.ResolveAnchors"],
  );
}
