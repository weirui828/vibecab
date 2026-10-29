import type { CommandEnvelope, Job, QueryEnvelope } from "../../../contract/src/index.js";
import type { EngineModule, EngineModuleHost, ModuleContext } from "../kernel/module-registry.js";

export function createModule(
  name: string,
  host: EngineModuleHost,
  commandNames: readonly string[],
  queryNames: readonly string[],
  jobs: Readonly<Record<string, "rerun" | "uncertain">> = {},
): EngineModule {
  return {
    name,
    commands: Object.fromEntries(
      commandNames.map((operation) => [
        operation,
        (
          _moduleContext: ModuleContext,
          ctx: import("../../../contract/src/index.js").CallContext,
          command: CommandEnvelope,
        ) => host.command(ctx, command),
      ]),
    ),
    queries: Object.fromEntries(
      queryNames.map((operation) => [
        operation,
        (
          _moduleContext: ModuleContext,
          ctx: import("../../../contract/src/index.js").CallContext,
          query: QueryEnvelope,
        ) => host.query(ctx, query),
      ]),
    ),
    jobKinds: Object.fromEntries(
      Object.entries(jobs).map(([kind, onLostLease]) => [
        kind,
        { run: (_moduleContext: ModuleContext, job: Job) => host.runJob(kind, job), onLostLease },
      ]),
    ),
  };
}
