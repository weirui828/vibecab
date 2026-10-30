import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fail } from "../../../contract/src/index.js";
import { httpClient } from "../../http/src/index.js";
import { readCliToken } from "./keychain.js";
import type { CliClient } from "./types.js";
import { start, status } from "./host.js";

export function nextCommandId(): string {
  return "cli-" + randomUUID();
}

export async function withClient<T>(workspaceDir: string, action: (client: CliClient) => Promise<T>): Promise<T> {
  const workspace = resolve(workspaceDir),
    host = await start(workspace),
    token = readCliToken(workspace);
  if (!host.running || !host.cliUrl || !token)
    fail("unauthenticated", "No CLI access token is stored in the OS keychain");
  return action(httpClient(host.cliUrl, token));
}

export async function createBootstrapToken(workspaceDir: string): Promise<void> {
  const host = await start(resolve(workspaceDir));
  if (!host.running || !(await status(workspaceDir)).running) fail("unavailable", "VibeCab host failed to start");
}
