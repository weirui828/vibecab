import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../src/engine.js";
import type {
  CallContext,
  CommandEnvelope,
  ElementDraft,
  EventEnvelope,
  QueryEnvelope,
  Subscription,
} from "../../contract/src/index.js";
import type { Dependencies } from "../src/dependencies.js";
import type { Engine } from "../src/engine.js";
export interface TestEngine {
  start(workspaceDir: string): Promise<void>;
  stop(): Promise<void>;
  drain(graceMs: number): Promise<void>;
  restoreBackup(archivePath: string, destinationDir: string): Promise<void>;
  command(ctx: CallContext, cmd: CommandEnvelope): ReturnType<Engine["command"]>;
  query(ctx: CallContext, q: QueryEnvelope): ReturnType<Engine["query"]>;
  subscribe(ctx: CallContext, sub: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(ctx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(ctx: CallContext, hash: string): Promise<Uint8Array>;
}
export const ctx: CallContext = {
  contractVersion: "1.0",
  principal: { kind: "human" },
  channel: "in_process",
  scope: "admin",
  requestId: "test",
};
let currentTime = Date.parse("2026-10-28T00:00:00.000Z");
export const clock = { now: () => new Date(currentTime).toISOString() };
export function advanceClock(milliseconds: number): void {
  currentTime += milliseconds;
}
export function resetClock(): void {
  currentTime = Date.parse("2026-10-28T00:00:00.000Z");
}
export function ids() {
  let n = 0;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return {
    next: (prefix: string) => {
      let number = ++n,
        encoded = "";
      do {
        encoded = alphabet[number % 32] + encoded;
        number = Math.floor(number / 32);
      } while (number);
      return prefix + encoded.padStart(26, "0");
    },
  };
}
export function paragraph(text: string): ElementDraft {
  return { type: "paragraph", props: {}, text };
}
export async function fixture(options: Partial<Dependencies> = {}) {
  resetClock();
  const dir = await mkdtemp(join(tmpdir(), "vibecab-"));
  const engine = createEngine({
    clock,
    ids: ids(),
    seed: 42,
    modelProviders: {},
    ...options,
  });
  await engine.start(dir);
  const compatibilityEngine: TestEngine = {
    start: engine.start.bind(engine),
    stop: engine.stop.bind(engine),
    drain: engine.drain.bind(engine),
    restoreBackup: engine.restoreBackup.bind(engine),
    command: (context: CallContext, command: Parameters<Engine["command"]>[2]) =>
      engine.command(engine.trustedHostAuth(context.scope), metadata(context), command),
    query: (context: CallContext, query: Parameters<Engine["query"]>[2]) =>
      engine.query(engine.trustedHostAuth(context.scope), metadata(context), query),
    subscribe: (context: CallContext, sub: Parameters<Engine["subscribe"]>[2]) =>
      engine.subscribe(engine.trustedHostAuth(context.scope), metadata(context), sub),
    putBlob: (context: CallContext, bytes: Uint8Array, mediaType: string) =>
      engine.putBlob(engine.trustedHostAuth(context.scope), metadata(context), bytes, mediaType),
    getBlob: (context: CallContext, hash: string) =>
      engine.getBlob(engine.trustedHostAuth(context.scope), metadata(context), hash),
  };
  return {
    engine: compatibilityEngine,
    rawEngine: engine,
    dir,
    close: async () => {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function metadata(context: CallContext) {
  return { contractVersion: context.contractVersion, requestId: context.requestId };
}
export function tokenFactory() {
  let n = 0;
  return () => ("test-token-" + ++n).padEnd(32, "0");
}
