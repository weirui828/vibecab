import { expect, it } from "vitest";
import type { CommandResult } from "../../contract/src/index.js";
import { purge } from "../../adapters/cli/src/operations.js";
import { exitCodes, main } from "../../adapters/cli/src/index.js";
import type { CliClient, CliIO } from "../../adapters/cli/src/types.js";

it("purge without confirmation performs only the preview query", async () => {
  const calls: string[] = [],
    client: CliClient = {
      async query(query) {
        calls.push("query:" + query.name);
        return { target: {}, recordIds: [] };
      },
      async command(): Promise<CommandResult> {
        calls.push("command");
        return { ok: true, result: {}, seq: 1 };
      },
      subscribe() {
        return { async *[Symbol.asyncIterator]() {} };
      },
      async putBlob() {
        return "0".repeat(64);
      },
      async getBlob() {
        return new Uint8Array();
      },
    };
  const result = await purge(client, { kind: "artifact", id: "a1" }, false);
  expect(result).toMatchObject({ queued: false, preview: { recordIds: [] } });
  expect(calls).toEqual(["query:vc.PurgePreview"]);
});

it("maps contract errors to stable CLI exit codes", () => {
  expect(exitCodes).toMatchObject({
    invalid: 2,
    unauthenticated: 3,
    forbidden: 4,
    conflict: 6,
    unsupported: 8,
    internal: 10,
  });
});

it("invokes through the CLI entry point and returns the documented unsupported exit code", async () => {
  const output: string[] = [],
    errors: string[] = [],
    io: CliIO = {
      writeOut: (text) => output.push(text),
      writeError: (text) => errors.push(text),
      readSecret: async () => "",
      writeBytes: () => {},
    };
  expect(await main(["review", "submit", "--json"], io)).toBe(8);
  expect(output).toEqual([]);
  expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "unsupported" } });
});
