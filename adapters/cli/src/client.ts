import { randomUUID } from "node:crypto";
import { Contract, CONTRACT_VERSION, fail } from "../../../contract/src/index.js";
import { createEngine } from "../../../engine/src/engine.js";
import type { CallMetadata, Engine } from "../../../engine/src/engine.js";
import { httpClient } from "../../http/src/index.js";
import { cliAdapter } from "./adapter.js";
import { readCliToken, saveCliToken } from "./keychain.js";
import type { CliClient } from "./types.js";
import { status } from "./host.js";

let requestNumber = 0;
function metadata(): CallMetadata {
  return { contractVersion: CONTRACT_VERSION, requestId: `cli-${++requestNumber}` };
}

async function bootstrapCliToken(engine: Engine, workspaceDir: string): Promise<string> {
  const current = readCliToken(workspaceDir);
  if (current) return current;
  const result = await engine.command(engine.inProcessAuth, metadata(), {
    commandId: "cli-bootstrap-" + randomUUID(),
    type: "sys.CreateAccessToken",
    payload: { name: "VibeCab CLI", channel: "cli", scope: "admin" },
  });
  if (!result.ok) fail(result.error.code, result.error.message, result.error.details);
  const parsed = new Contract().read<{ token: string }>(
    "operations/sys.CreateAccessToken",
    result.result,
    "#/properties/result",
  );
  saveCliToken(workspaceDir, parsed.token);
  return parsed.token;
}

export async function withClient<T>(
  workspaceDir: string,
  action: (client: CliClient, engine?: Engine) => Promise<T>,
): Promise<T> {
  const current = await status(workspaceDir);
  if (current.running) {
    const token = readCliToken(workspaceDir);
    if (!token || !current.cliUrl) fail("unauthenticated", "No CLI access token is stored in the OS keychain");
    const client = httpClient(current.cliUrl, token);
    return action(client);
  }
  const engine = createEngine();
  await engine.start(workspaceDir);
  try {
    const token = await bootstrapCliToken(engine, workspaceDir);
    return await action(cliAdapter(engine, token), engine);
  } finally {
    await engine.stop();
  }
}

export async function createBootstrapToken(workspaceDir: string): Promise<void> {
  if ((await status(workspaceDir)).running) return;
  if (readCliToken(workspaceDir)) return;
  const engine = createEngine();
  await engine.start(workspaceDir);
  try {
    await bootstrapCliToken(engine, workspaceDir);
  } finally {
    await engine.stop();
  }
}

export function nextCommandId(): string {
  return "cli-" + randomUUID();
}
