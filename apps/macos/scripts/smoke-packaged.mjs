import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

if (process.platform !== "darwin") throw new Error("Packaged app smoke requires macOS LaunchServices.");

const appPath = resolve("release/mac-arm64/VibeCab.app"),
  cli = join(appPath, "Contents/Resources/engine/bin/vibecab"),
  home = await mkdtemp(join(tmpdir(), "vibecab-app-smoke-home-")),
  workspace = join(home, "workspace"),
  readyFile = join(home, "ready"),
  pidFile = join(home, "app.pid"),
  logFile = join(home, "app.log"),
  env = {
    ...process.env,
    HOME: home,
    VIBECAB_DEV: "1",
    VIBECAB_KEYSTORE: "memory",
    VIBECAB_SMOKE: "1",
    VIBECAB_SMOKE_READY_FILE: readyFile,
    VIBECAB_SMOKE_PID_FILE: pidFile,
    VIBECAB_SMOKE_LOG_FILE: logFile,
    VIBECAB_WORKSPACE_DIR: workspace,
  },
  app = spawn(
    "open",
    [
      "-W",
      "-n",
      "-a",
      appPath,
      "--args",
      "--vibecab-smoke",
      `--vibecab-workspace=${workspace}`,
      `--vibecab-smoke-ready-file=${readyFile}`,
      `--vibecab-smoke-pid-file=${pidFile}`,
      `--vibecab-smoke-log-file=${logFile}`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
let stdout = "",
  stderr = "";
app.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
app.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

async function contents(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`LaunchServices exited before ready (code ${String(app.exitCode)}).`);
    const marker = await contents(readyFile);
    if (marker.split(/\r?\n/).includes("VIBECAB_READY")) return;
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 100));
  }
  throw new Error("Packaged app did not report ready within 30 seconds.");
}

async function stopApp() {
  const pidText = await contents(pidFile),
    pid = Number(pidText.trim());
  if (Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It may have exited after reporting ready.
    }
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 1_000));
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has exited.
    }
  }
  if (app.exitCode === null && app.signalCode === null) {
    await Promise.race([
      new Promise((resolveExit) => app.once("exit", resolveExit)),
      new Promise((resolveTimeout) => globalThis.setTimeout(() => resolveTimeout(undefined), 5_000)),
    ]);
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGTERM");
  }
}

let failed = false;
try {
  await waitForReady();
  process.stdout.write("Packaged app reported VIBECAB_READY via LaunchServices.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await stopApp();
  try {
    execFileSync(cli, ["stop", "--workspace", workspace], { env, stdio: "ignore", timeout: 10_000 });
  } catch {
    // The host may not have started if the app failed before reporting ready.
  }
  const appLog = await contents(logFile);
  if (/No handler registered|uncaught exception/i.test(stderr + appLog)) {
    failed = true;
    process.stderr.write("Packaged app smoke found an IPC handler error or uncaught exception.\n");
  }
  if (stderr) process.stderr.write(stderr);
  if (appLog) process.stderr.write(appLog);
  if (stdout) process.stdout.write(stdout);
  await rm(home, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
