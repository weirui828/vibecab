import { monotonicFactory } from "ulid";
import type { KeyStore, ModelProvider } from "./gateway/types.js";
import { NativeKeyStore } from "./gateway/keys.js";
import type { ToolTransport } from "./agent/tool-transport.js";
export interface Clock {
  now(): string;
}
export interface IdGenerator {
  next(prefix: string): string;
}
export interface Dependencies {
  clock: Clock;
  ids: IdGenerator;
  seed: number;
  trustedHostScope: "read" | "collaborate" | "admin";
  keyStore: KeyStore;
  toolTransport?: ToolTransport;
  modelProviders: Record<string, ModelProvider>;
  updateCheckpoint?: (updateId: string, stage: "checking") => Promise<void>;
}
export function defaults(): Dependencies {
  const next = monotonicFactory();
  return {
    clock: { now: () => new Date().toISOString() },
    ids: { next: (prefix) => prefix + next() },
    seed: 0,
    trustedHostScope: "admin",
    keyStore: new NativeKeyStore(),
    modelProviders: {},
  };
}
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
