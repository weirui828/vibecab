import type {
  CallContext,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
} from "../../contract/src/index.js";
import type { Dependencies } from "./kernel/dependencies.js";
import { defaults } from "./kernel/dependencies.js";
import { UpdateRuntime } from "./updates/runtime.js";

export interface Engine {
  start(workspaceDir: string): Promise<void>;
  drain(graceMs: number): Promise<void>;
  stop(): Promise<void>;
  command(ctx: CallContext, cmd: CommandEnvelope): Promise<CommandResult>;
  query(ctx: CallContext, q: QueryEnvelope): Promise<Json>;
  subscribe(ctx: CallContext, sub: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(ctx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(ctx: CallContext, hash: string): Promise<Uint8Array>;
}

class LocalEngine extends UpdateRuntime implements Engine {}
export function createEngine(options: Partial<Dependencies> = {}): Engine {
  return new LocalEngine({ ...defaults(), ...options });
}
