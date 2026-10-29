import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";

export function lifecycleModule(host: EngineModuleHost) {
  const engineModule = createModule(
    "lifecycle",
    host,
    [
      "vc.MarkSeen",
      "vc.CreateOutputSet",
      "vc.Label",
      "vc.Export",
      "vc.Trash",
      "vc.Restore",
      "vc.Purge",
      "sys.Backup",
      "vc.EditDigest",
    ],
    ["vc.OutputSets", "vc.Labels", "vc.Exports", "sys.Backups", "vc.Digest", "vc.ResumeView", "vc.PurgePreview"],
    { digest: "rerun", export: "rerun", backup: "rerun", purge: "rerun", "trash.sweep": "rerun" },
  );
  engineModule.onStart = (context) => {
    const activeSweep = context.repository
      .jobs()
      .some((job) => job.kind === "trash.sweep" && ["pending", "leased"].includes(job.state));
    if (activeSweep) return;
    const id = context.ids.next("trash_sweep_");
    context.enqueue("trash.sweep", id, context.contract.read("json", {}), context.clock.now());
  };
  return engineModule;
}
