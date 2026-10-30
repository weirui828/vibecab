import { spawn } from "node:child_process";
import { open, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { HostStartOptions, HostStatus, HostStopOptions } from "./types.js";

type RuntimeFile = {
  pid: number;
  startedAt: string;
  contractVersion: string;
  httpUrl: string;
  cliUrl: string;
  mcpUrl: string;
};
const timeoutMs = 35_000;

function runtimePath(workspace: string): string {
  return join(workspace, ".vibecab", "server.json");
}

async function runtime(workspace: string): Promise<RuntimeFile | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(runtimePath(workspace), "utf8"));
    if (!isRecord(value)) return undefined;
    const { pid, startedAt, contractVersion, httpUrl, cliUrl, mcpUrl } = value;
    if (
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      typeof startedAt === "string" &&
      typeof contractVersion === "string" &&
      typeof httpUrl === "string" &&
      typeof cliUrl === "string" &&
      typeof mcpUrl === "string"
    )
      return { pid, startedAt, contractVersion, httpUrl, cliUrl, mcpUrl };
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    value = await runtime(workspace);
  if (!value || !processExists(value.pid)) return { running: false };
  return { running: true, ...value };
}

export async function start(workspaceDir: string, options: HostStartOptions = {}): Promise<HostStatus> {
  const workspace = resolve(workspaceDir),
    current = await status(workspace);
  if (current.running) return current;
  const directory = join(workspace, ".vibecab");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "start.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    for (let attempt = 0; attempt < timeoutMs / 50; attempt++) {
      await delay(50);
      const running = await status(workspace);
      if (running.running) return running;
      if (!(await exists(lockPath))) return start(workspaceDir, options);
    }
    throw new Error("VibeCab host startup is already in progress");
  }
  try {
    const afterLock = await status(workspace);
    if (afterLock.running) return afterLock;
    const stale = await runtime(workspace);
    if (stale && !processExists(stale.pid)) await rm(runtimePath(workspace), { force: true });
    const hostEntry = options.hostEntry ?? fileURLToPath(new URL("../bin/vibecab-host.mjs", import.meta.url));
    const child = spawn(
      options.nodePath ?? process.execPath,
      [
        hostEntry,
        "serve",
        "--workspace",
        workspace,
        ...(options.fakeProvider ? ["--fake-provider", options.fakeProvider] : []),
      ],
      { detached: true, stdio: "ignore", env: process.env },
    );
    child.unref();
    for (let attempt = 0; attempt < timeoutMs / 50; attempt++) {
      await delay(50);
      const running = await status(workspace);
      if (running.running) return running;
      if (child.exitCode !== null) break;
    }
    throw new Error("VibeCab host did not start");
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function stop(workspaceDir: string, options: HostStopOptions = {}): Promise<HostStatus> {
  const current = await status(workspaceDir);
  if (!current.running) return current;
  process.kill(current.pid, "SIGTERM");
  const attempts = Math.ceil((options.timeoutMs ?? timeoutMs) / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await delay(50);
    if (!processExists(current.pid)) return { running: false };
  }
  throw new Error("VibeCab host did not stop before the timeout");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
