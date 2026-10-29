import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fail } from "../../../contract/src/index.js";
import { createEngine } from "../../../engine/src/engine.js";
import type { Engine } from "../../../engine/src/engine.js";
import { startHttp } from "../../http/src/index.js";

export interface HostStatus {
  running: boolean;
  pid?: number;
  cliUrl?: string;
  httpUrl?: string;
}

interface RuntimeFile {
  pid: number;
  cliUrl: string;
  httpUrl: string;
}

function runtimePath(workspace: string): string {
  return join(workspace, ".vibecab", "server.json");
}

async function readRuntime(workspace: string): Promise<RuntimeFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(runtimePath(workspace), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof Reflect.get(parsed, "pid") === "number" &&
      typeof Reflect.get(parsed, "cliUrl") === "string" &&
      typeof Reflect.get(parsed, "httpUrl") === "string"
    )
      return {
        pid: Reflect.get(parsed, "pid"),
        cliUrl: Reflect.get(parsed, "cliUrl"),
        httpUrl: Reflect.get(parsed, "httpUrl"),
      };
  } catch {
    return undefined;
  }
  return undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function status(workspaceDir: string): Promise<HostStatus> {
  const workspace = resolve(workspaceDir),
    runtime = await readRuntime(workspace);
  if (!runtime || !processExists(runtime.pid)) return { running: false };
  return { running: true, pid: runtime.pid, cliUrl: runtime.cliUrl, httpUrl: runtime.httpUrl };
}

export async function start(workspaceDir: string): Promise<HostStatus> {
  const workspace = resolve(workspaceDir),
    current = await status(workspace);
  if (current.running) return current;
  await mkdir(join(workspace, ".vibecab"), { recursive: true });
  const executable = process.argv[1];
  if (!executable) fail("unavailable", "Cannot locate the vibecab executable");
  const child = spawn(process.execPath, [executable, "__serve", "--workspace", workspace], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(50);
    const next = await status(workspace);
    if (next.running) return next;
    if (child.exitCode !== null) break;
  }
  fail("unavailable", "VibeCab server did not start");
}

export async function stop(workspaceDir: string): Promise<HostStatus> {
  const workspace = resolve(workspaceDir),
    current = await status(workspace);
  if (!current.running || !current.pid) return { running: false };
  process.kill(current.pid, "SIGTERM");
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(50);
    if (!processExists(current.pid)) return { running: false };
  }
  fail("unavailable", "VibeCab server did not stop");
}

export async function serve(workspaceDir: string): Promise<void> {
  const workspace = resolve(workspaceDir),
    engine: Engine = createEngine();
  await engine.start(workspace);
  let http: Awaited<ReturnType<typeof startHttp>> | undefined, cli: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    http = await startHttp(engine, { port: 0, transport: "http" });
    cli = await startHttp(engine, { port: 0, transport: "cli" });
  } catch (error) {
    await http?.close();
    await engine.stop();
    throw error;
  }
  const file: RuntimeFile = { pid: process.pid, cliUrl: cli.url, httpUrl: http.url },
    path = runtimePath(workspace);
  await mkdir(join(workspace, ".vibecab"), { recursive: true });
  await writeFile(path, JSON.stringify(file), { mode: 0o600 });
  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= (async () => {
      await Promise.all([http!.close(), cli!.close()]);
      await engine.stop();
      await rm(path, { force: true });
    })();
    return stopping;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await new Promise<void>((resolveExit) => {
    process.once("beforeExit", resolveExit);
  });
  await shutdown();
}

export function commandId(): string {
  return "cli-" + randomUUID();
}
