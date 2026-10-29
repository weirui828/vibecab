import { expect, it } from "vitest";
import { ModuleRegistry } from "../src/kernel/module-registry.js";
import type { EngineModule } from "../src/kernel/module-registry.js";

function module(name: string, commands: Record<string, EngineModule["commands"][string]> = {}): EngineModule {
  return { name, commands, queries: {}, jobKinds: {} };
}

it("rejects duplicate operation registrations across modules", () => {
  expect(
    () =>
      new ModuleRegistry(
        [module("first", { "vc.Test": () => null }), module("second", { "vc.Test": () => null })],
        [{ name: "vc.Test", kind: "command" }],
      ),
  ).toThrow(/duplicate operation/i);
});

it("rejects supported operations without a module handler", () => {
  expect(() => new ModuleRegistry([module("content")], [{ name: "vc.Missing", kind: "command" }])).toThrow(
    /no handler/i,
  );
});

it("rejects handlers for operations absent from the supported contract catalog", () => {
  expect(() => new ModuleRegistry([module("content", { "vc.Unknown": () => null })], [])).toThrow(/unknown operation/i);
});

it("rejects duplicate job kind registrations", () => {
  const job = { run: async () => {}, onLostLease: "rerun" as const };
  expect(
    () =>
      new ModuleRegistry(
        [
          { ...module("one"), jobKinds: { example: job } },
          { ...module("two"), jobKinds: { example: job } },
        ],
        [],
      ),
  ).toThrow(/duplicate job kind/i);
});
