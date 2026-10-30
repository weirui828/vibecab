import type {
  CallContext,
  CommandEnvelope,
  EventEnvelope,
  Job,
  Json,
  QueryEnvelope,
  JsonSchema,
} from "../../../contract/src/index.js";
import type { Clock, IdGenerator } from "../dependencies.js";
import type { Repository } from "../storage/repository.js";

export interface ContractValidator {
  read<T>(schemaName: string, value: unknown, path?: string): T;
  schemaIsValid(schema: JsonSchema): boolean;
}

export interface GatewayRequestPort {
  modelRef: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  }>;
  tools?: Array<{ name: string; description: string; parameters: JsonSchema }>;
  output?: { kind: "text" } | { kind: "json"; schema: JsonSchema; name: string };
  maxOutputTokens: number;
  temperature?: number;
}

export type GatewayEventPort =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; arguments: unknown } }
  | { type: "output"; json: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; quality: "reported" | "estimated" | "unknown" }
  | { type: "done"; finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error" }
  | {
      type: "error";
      code: "provider_error" | "rate_limited" | "auth" | "unsupported" | "timeout" | "cancelled";
      message: string;
      retryable: boolean;
    };

export interface GatewayPort {
  call(
    request: GatewayRequestPort,
    options: { reservationId: string; idempotencyKey: string; signal: AbortSignal },
  ): AsyncIterable<GatewayEventPort>;
}

export interface BudgetPort {
  markTurnUncertain(turnId: string): void;
  markUncertain(reservationId: string): void;
  setRunLimit(runId: string, limitMicros: number): void;
  reserve(reservationId: string, runId: string, amountMicros: number): void;
}

export interface EngineModuleHost {
  command(ctx: CallContext, command: CommandEnvelope): unknown;
  query(ctx: CallContext, query: QueryEnvelope): unknown;
  runJob(kind: string, job: Job): Promise<void>;
}

export interface ModuleContext {
  repository: Repository;
  mutate<T>(action: () => T): Promise<T>;
  clock: Clock;
  ids: IdGenerator;
  contract: ContractValidator;
  appendEvent(event: Omit<EventEnvelope, "seq">): EventEnvelope;
  enqueue(kind: string, id: string, payload: Json, ts: string): void;
  settings(): Json;
  gateway?: GatewayPort;
  budgets?: BudgetPort;
}

export type CommandHandler = (ctx: ModuleContext, callContext: CallContext, command: CommandEnvelope) => unknown;
export type QueryHandler = (ctx: ModuleContext, callContext: CallContext, query: QueryEnvelope) => unknown;
export type JobHandler = (ctx: ModuleContext, job: Job) => Promise<void>;

export interface EngineModule {
  name: string;
  commands: Record<string, CommandHandler>;
  queries: Record<string, QueryHandler>;
  jobKinds: Record<string, { run: JobHandler; onLostLease: "rerun" | "uncertain" }>;
  recover?(ctx: ModuleContext): void;
  onStart?(ctx: ModuleContext): void;
  onDrain?(ctx: ModuleContext): Promise<void>;
}

export class ModuleRegistry {
  readonly commands = new Map<string, { module: EngineModule; handler: CommandHandler }>();
  readonly queries = new Map<string, { module: EngineModule; handler: QueryHandler }>();
  readonly jobKinds = new Map<string, { module: EngineModule; run: JobHandler; onLostLease: "rerun" | "uncertain" }>();

  constructor(
    readonly modules: readonly EngineModule[],
    supportedOperations: readonly { name: string; kind: "command" | "query" }[],
  ) {
    const supported = new Map(supportedOperations.map(({ name, kind }) => [name, kind])),
      registered = new Set<string>();
    for (const engineModule of modules) {
      for (const [name, handler] of Object.entries(engineModule.commands)) {
        this.registerOperation(name, "command", handler, supported, registered, engineModule);
      }
      for (const [name, handler] of Object.entries(engineModule.queries)) {
        this.registerOperation(name, "query", handler, supported, registered, engineModule);
      }
      for (const [kind, definition] of Object.entries(engineModule.jobKinds)) {
        if (this.jobKinds.has(kind)) throw new Error(`Duplicate job kind registration: ${kind}`);
        this.jobKinds.set(kind, { module: engineModule, ...definition });
      }
    }
    const missing = [...supported.keys()].filter((name) => !registered.has(name));
    if (missing.length > 0) throw new Error(`Supported contract operations have no handler: ${missing.join(", ")}`);
  }

  private registerOperation(
    name: string,
    kind: "command" | "query",
    handler: CommandHandler | QueryHandler,
    supported: Map<string, "command" | "query">,
    registered: Set<string>,
    engineModule: EngineModule,
  ): void {
    if (registered.has(name)) throw new Error(`Duplicate operation registration: ${name}`);
    const supportedKind = supported.get(name);
    if (!supportedKind) throw new Error(`Module ${engineModule.name} registered unknown operation: ${name}`);
    if (supportedKind !== kind)
      throw new Error(`Module ${engineModule.name} registered ${name} as the wrong operation kind`);
    registered.add(name);
    if (kind === "command") this.commands.set(name, { module: engineModule, handler: handler as CommandHandler });
    else this.queries.set(name, { module: engineModule, handler: handler as QueryHandler });
  }
}
