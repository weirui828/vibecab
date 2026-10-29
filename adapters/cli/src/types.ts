import type {
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
} from "../../../contract/src/index.js";

export interface CliClient {
  command(command: CommandEnvelope): Promise<CommandResult>;
  query(query: QueryEnvelope): Promise<Json>;
  subscribe(subscription: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array>;
}

export interface CliIO {
  writeOut(text: string): void;
  writeError(text: string): void;
  readSecret(prompt: string): Promise<string>;
  writeBytes(bytes: Uint8Array): void;
}
