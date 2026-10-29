import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { Contract, errorOf, fail } from "../../../contract/src/index.js";
import type { CommandEnvelope, Json } from "../../../contract/src/index.js";
import { createEngine } from "../../../engine/src/engine.js";
import { httpClient } from "../../http/src/index.js";
import { createBootstrapToken, nextCommandId, withClient } from "./client.js";
import { purge } from "./operations.js";
import { serve, start, status, stop } from "./host.js";
import { readCliToken, readSecret, saveProviderKey } from "./keychain.js";
import type { CliClient, CliIO } from "./types.js";

export const exitCodes: Record<string, number> = {
  invalid: 2,
  unauthenticated: 3,
  forbidden: 4,
  not_found: 5,
  conflict: 6,
  stale_base: 6,
  locked: 6,
  budget_exceeded: 7,
  rate_limited: 7,
  unsupported: 8,
  unavailable: 9,
  uncertain: 9,
  internal: 10,
};

interface Parsed {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function parse(args: string[]): Parsed {
  const positionals: string[] = [],
    values = new Map<string, string>(),
    flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const current = args[index]!;
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }
    const key = current.slice(2),
      value = args[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      values.set(key, value);
      index++;
    } else flags.add(key);
  }
  return { positionals, values, flags };
}

function defaultIO(): CliIO {
  return {
    writeOut: (text) => stdout.write(text + "\n"),
    writeError: (text) => stderr.write(text + "\n"),
    readSecret,
    writeBytes: (bytes) => stdout.write(bytes),
  };
}

async function inputText(path: string): Promise<string> {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(resolve(path), "utf8");
}

function jsonValue(input: string): Json {
  try {
    return new Contract().read<Json>("json", JSON.parse(input));
  } catch {
    fail("invalid", "Expected valid JSON input");
  }
}

function emit(io: CliIO, value: unknown, json: boolean): void {
  if (typeof value === "string" && !json) io.writeOut(value);
  else io.writeOut(JSON.stringify(value, null, json ? undefined : 2));
}

function required(parsed: Parsed, key: string): string {
  const value = parsed.values.get(key);
  if (!value) fail("invalid", `Missing --${key}`);
  return value;
}

async function sendCommand(client: CliClient, cmd: CommandEnvelope) {
  const result = await client.command(cmd);
  if (!result.ok) fail(result.error.code, result.error.message, result.error.details);
  return result.result;
}

async function handle(command: string, args: string[], io: CliIO): Promise<unknown> {
  const parsed = parse(args),
    jsonOutput = parsed.flags.has("json"),
    workspace = resolve(parsed.values.get("workspace") ?? process.cwd()),
    positional = parsed.positionals;
  if (command === "start") {
    await createBootstrapToken(workspace);
    return start(workspace);
  }
  if (command === "stop") return stop(workspace);
  if (command === "status") return status(workspace);
  if (command === "__serve") {
    const serveArgs = parse(args);
    await serve(resolve(serveArgs.values.get("workspace") ?? process.cwd()));
    return undefined;
  }
  if (command === "restore-backup") {
    const archive = positional[0];
    if (!archive) fail("invalid", "Usage: vibecab restore-backup <archive> --destination <directory>");
    const destination = required(parsed, "destination"),
      current = await status(workspace);
    if (current.running) await stop(workspace);
    const engine = createEngine();
    await engine.restoreBackup(resolve(archive), resolve(destination));
    return { restored: true, destination: resolve(destination) };
  }
  if (command === "cmd") {
    const type = positional[0],
      jsonPath = required(parsed, "json");
    if (!type) fail("invalid", "Usage: vibecab cmd <type> --json <file|->");
    const payload = jsonValue(await inputText(jsonPath));
    return withClient(workspace, async (client) =>
      sendCommand(client, {
        commandId: parsed.values.get("command-id") ?? nextCommandId(),
        type,
        payload,
      }),
    );
  }
  if (command === "query") {
    const name = positional[0];
    if (!name) fail("invalid", "Usage: vibecab query <name> --args <json>");
    const argsValue = jsonValue(required(parsed, "args"));
    return withClient(workspace, (client) => client.query({ name, args: argsValue }));
  }
  if (command === "blob") {
    const action = positional[0];
    if (action === "put") {
      const path = positional[1];
      if (!path) fail("invalid", "Usage: vibecab blob put <file> --media-type <type>");
      const bytes = new Uint8Array(await readFile(resolve(path))),
        mediaType = required(parsed, "media-type");
      return withClient(workspace, async (client) => ({ hash: await client.putBlob(bytes, mediaType) }));
    }
    if (action === "get") {
      const hash = positional[1];
      if (!hash) fail("invalid", "Usage: vibecab blob get <hash> --output <file|->");
      const output = required(parsed, "output");
      return withClient(workspace, async (client) => {
        const bytes = await client.getBlob(hash);
        if (output === "-") {
          io.writeBytes(bytes);
          return undefined;
        }
        await writeFile(resolve(output), bytes);
        return { hash, output: resolve(output), bytes: bytes.length };
      });
    }
    fail("invalid", "Usage: vibecab blob put|get");
  }
  if (command === "events") {
    if (!parsed.flags.has("follow")) fail("invalid", "Usage: vibecab events --follow [--after <seq>]");
    const afterSeq = Number(parsed.values.get("after") ?? "0");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail("invalid", "Invalid event cursor");
    return withClient(workspace, async (client) => {
      const iterator = client.subscribe({ afterSeq })[Symbol.asyncIterator]();
      const onSignal = () => void iterator.return?.();
      process.once("SIGINT", onSignal);
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          emit(io, next.value, jsonOutput);
        }
      } finally {
        process.off("SIGINT", onSignal);
        await iterator.return?.();
      }
      return undefined;
    });
  }
  if (command === "export") {
    const target = parsed.values.get("output-set")
      ? { outputSetId: parsed.values.get("output-set")! }
      : {
          artifactId: required(parsed, "artifact"),
          ...(parsed.values.get("version") ? { version: Number(parsed.values.get("version")) } : {}),
        };
    const payload = new Contract().read<Json>("json", {
      target,
      format: parsed.values.get("format") ?? "markdown",
      ...(parsed.flags.has("threads") ? { include: { threads: true } } : {}),
    });
    return withClient(workspace, (client) =>
      sendCommand(client, { commandId: nextCommandId(), type: "vc.Export", payload }),
    );
  }
  if (command === "backup")
    return withClient(workspace, (client) =>
      sendCommand(client, { commandId: nextCommandId(), type: "sys.Backup", payload: {} }),
    );
  if (command === "purge") {
    const target = { kind: required(parsed, "kind"), id: required(parsed, "id") };
    return withClient(workspace, (client) => purge(client, target, parsed.flags.has("yes")));
  }
  if (command === "tokens") {
    const action = positional[0];
    if (action === "list")
      return withClient(workspace, (client) => client.query({ name: "sys.AccessTokens", args: {} }));
    if (action === "create") {
      const channel = parsed.values.get("channel") ?? "cli",
        scope = parsed.values.get("scope") ?? (channel === "mcp" ? "collaborate" : "admin");
      return withClient(workspace, (client) =>
        sendCommand(client, {
          commandId: nextCommandId(),
          type: "sys.CreateAccessToken",
          payload: { name: parsed.values.get("name") ?? `VibeCab ${channel}`, channel, scope },
        }),
      );
    }
    if (action === "revoke") {
      const tokenId = positional[1];
      if (!tokenId) fail("invalid", "Usage: vibecab tokens revoke <token-id>");
      return withClient(workspace, (client) =>
        sendCommand(client, { commandId: nextCommandId(), type: "sys.RevokeAccessToken", payload: { tokenId } }),
      );
    }
    fail("invalid", "Usage: vibecab tokens create|list|revoke");
  }
  if (command === "keys" && positional[0] === "set") {
    const alias = positional[1];
    if (!alias) fail("invalid", "Usage: vibecab keys set <alias>");
    const secret = await io.readSecret(`Provider secret for ${alias}: `);
    if (!secret) fail("invalid", "Provider secret cannot be empty");
    saveProviderKey(alias, secret);
    return withClient(workspace, (client) =>
      sendCommand(client, {
        commandId: nextCommandId(),
        type: "sys.SetProviderKeyRef",
        payload: { alias, keyRef: `provider:${alias}` },
      }),
    );
  }
  if (command === "review") fail("unsupported", "Review commands arrive in Task 11");
  fail("invalid", `Unknown command: ${command}`);
}

export async function main(args = process.argv.slice(2), io = defaultIO()): Promise<number> {
  const [command, ...rest] = args;
  if (!command) {
    io.writeError(
      "Usage: vibecab <start|stop|status|cmd|query|events|export|backup|restore-backup|purge|tokens|keys|review>",
    );
    return 2;
  }
  try {
    const result = await handle(command, rest, io),
      outputOptions = parse(rest),
      json = command === "cmd" || outputOptions.flags.has("json");
    if (result !== undefined) emit(io, result, json);
    return 0;
  } catch (error) {
    const contract = errorOf(error),
      code = exitCodes[contract.code] ?? 10,
      wantsJson = parse(rest).flags.has("json");
    if (wantsJson) io.writeError(JSON.stringify({ error: contract }));
    else io.writeError(`${contract.code}: ${contract.message}`);
    return code;
  }
}

export { httpClient, readCliToken };
