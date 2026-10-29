import { CONTRACT_VERSION } from "../../../contract/src/index.js";
import type { CommandEnvelope, QueryEnvelope, Subscription } from "../../../contract/src/index.js";
import type { Engine } from "../../../engine/src/engine.js";
import type { CliClient } from "./types.js";

export function cliAdapter(engine: Engine, secret: string): CliClient {
  let requestNumber = 0;
  const auth = { kind: "token" as const, secret, transport: "cli" as const },
    metadata = () => ({ contractVersion: CONTRACT_VERSION, requestId: `cli-adapter-${++requestNumber}` });
  return {
    command: (command: CommandEnvelope) => engine.command(auth, metadata(), command),
    query: (query: QueryEnvelope) => engine.query(auth, metadata(), query),
    subscribe: (subscription: Subscription) => engine.subscribe(auth, metadata(), subscription),
    putBlob: (bytes: Uint8Array, mediaType: string) => engine.putBlob(auth, metadata(), bytes, mediaType),
    getBlob: (hash: string) => engine.getBlob(auth, metadata(), hash),
  };
}
