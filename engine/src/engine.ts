import type {
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
import type { CallAuth, CallMetadata, TrustedHostCredential } from "./auth.js";

export type { CallAuth, CallMetadata } from "./auth.js";
export type { ToolTransport } from "./agent/tool-transport.js";

export interface Engine {
  readonly inProcessAuth: TrustedHostCredential;
  trustedHostAuth(scope: TrustedHostCredential["scope"]): TrustedHostCredential;
  start(workspaceDir: string): Promise<void>;
  drain(graceMs: number): Promise<void>;
  stop(): Promise<void>;
  restoreBackup(archivePath: string, destinationDir: string): Promise<void>;
  command(auth: CallAuth, metadata: CallMetadata, cmd: CommandEnvelope): Promise<CommandResult>;
  query(auth: CallAuth, metadata: CallMetadata, q: QueryEnvelope): Promise<Json>;
  subscribe(auth: CallAuth, metadata: CallMetadata, sub: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(auth: CallAuth, metadata: CallMetadata, bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(auth: CallAuth, metadata: CallMetadata, hash: string): Promise<Uint8Array>;
}

class LocalEngine extends LifecycleRuntime implements Engine {
  readonly inProcessAuth: TrustedHostCredential;
  private readonly hostAuthByScope: Record<TrustedHostCredential["scope"], TrustedHostCredential>;

  constructor(options: Dependencies) {
    super(options);
    this.hostAuthByScope = {
      read: this.mintTrustedHost("read"),
      collaborate: this.mintTrustedHost("collaborate"),
      admin: this.mintTrustedHost("admin"),
    };
    this.inProcessAuth = this.hostAuthByScope[options.trustedHostScope];
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

  trustedHostAuth(scope: TrustedHostCredential["scope"]): TrustedHostCredential {
    return this.hostAuthByScope[scope];
  }
}
export function createEngine(options: Partial<Dependencies> = {}): Engine {
  return new LocalEngine({ ...defaults(), ...options });
}
