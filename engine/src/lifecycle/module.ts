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
    // Completed sweep ticks are maintenance state, not history; discard old ticks to keep polling bounded.
    context.repository.pruneCompletedJobs("trash.sweep");
    const activeSweep = context.repository
      .jobs()
      .find((job) => job.kind === "trash.sweep" && ["pending", "leased", "interrupted"].includes(job.state));
    const now = context.clock.now(),
      startupDelay = new Date(Date.parse(now) + 5 * 60_000).toISOString();
    if (activeSweep) {
      const notBefore = field(activeSweep.payload, "notBefore");
      if (activeSweep.state === "leased" || typeof notBefore !== "string" || Date.parse(notBefore) <= Date.parse(now))
        context.repository.rescheduleJob(
          activeSweep.id,
          context.contract.read("json", { notBefore: startupDelay }),
          now,
        );
      return;
    }
    const id = context.ids.next("trash_sweep_");
    context.enqueue("trash.sweep", id, context.contract.read("json", { notBefore: startupDelay }), now);
  };
  return engineModule;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
