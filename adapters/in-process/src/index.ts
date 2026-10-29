import { CONTRACT_VERSION } from "../../../contract/src/index.js";
import type { CommandEnvelope, QueryEnvelope, Subscription } from "../../../contract/src/index.js";
import type { Engine } from "../../../engine/src/engine.js";
export interface InProcessClient {
  command(cmd: CommandEnvelope): ReturnType<Engine["command"]>;
  query(query: QueryEnvelope): ReturnType<Engine["query"]>;
  subscribe(sub: Subscription): ReturnType<Engine["subscribe"]>;
  putBlob(bytes: Uint8Array, mediaType: string): ReturnType<Engine["putBlob"]>;
  getBlob(hash: string): ReturnType<Engine["getBlob"]>;
}
export function inProcess(
  engine: Engine,
  options: {
    scope?: "read" | "collaborate" | "admin";
    contractVersion?: string;
  } = {},
): InProcessClient {
  let n = 0;
  const metadata = () => ({
    contractVersion: options.contractVersion ?? CONTRACT_VERSION,
    requestId: "in-process-" + ++n,
  });
  const auth = engine.trustedHostAuth(options.scope ?? "admin");
  return {
    command: (cmd: CommandEnvelope) => engine.command(auth, metadata(), cmd),
    query: (query: QueryEnvelope) => engine.query(auth, metadata(), query),
    subscribe: (sub: Subscription) => engine.subscribe(auth, metadata(), sub),
    putBlob: (bytes: Uint8Array, mediaType: string) => engine.putBlob(auth, metadata(), bytes, mediaType),
    getBlob: (hash: string) => engine.getBlob(auth, metadata(), hash),
  };
}
