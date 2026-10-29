import type {
  CallContext,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
} from "../../contract/src/index.js";
import type { Dependencies } from "./dependencies.js";
import { defaults } from "./dependencies.js";
import { LifecycleRuntime } from "./lifecycle/runtime.js";
import { contentModule } from "./content/module.js";
import { feedbackModule } from "./feedback/module.js";
import { agentModule } from "./agent/module.js";
import { updatesModule } from "./updates/module.js";
import { gatewayModule } from "./gateway/module.js";
import { lifecycleModule } from "./lifecycle/module.js";
import type { EngineModuleHost } from "./kernel/module-registry.js";

export interface Engine {
  start(workspaceDir: string): Promise<void>;
  drain(graceMs: number): Promise<void>;
  stop(): Promise<void>;
  restoreBackup(archivePath: string, destinationDir: string): Promise<void>;
  command(ctx: CallContext, cmd: CommandEnvelope): Promise<CommandResult>;
  query(ctx: CallContext, q: QueryEnvelope): Promise<Json>;
  subscribe(ctx: CallContext, sub: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(ctx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(ctx: CallContext, hash: string): Promise<Uint8Array>;
}

class LocalEngine extends LifecycleRuntime implements Engine {
  constructor(options: Dependencies) {
    super(options);
    const host: EngineModuleHost = {
      command: (ctx, command) => this.dispatchLegacyCommand(ctx, command),
      query: (ctx, query) => this.dispatchLegacyQuery(ctx, query),
      runJob: (kind, job) => this.runEngineJob(kind, job),
    };
    this.configureModules([
      contentModule(host),
      feedbackModule(host),
      agentModule(host),
      updatesModule(host),
      gatewayModule(host),
      lifecycleModule(host),
    ]);
  }
}
export function createEngine(options: Partial<Dependencies> = {}): Engine {
  return new LocalEngine({ ...defaults(), ...options });
}
