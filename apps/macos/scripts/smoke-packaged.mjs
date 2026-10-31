import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const appPath = resolve("release/mac-arm64/VibeCab.app"),
  executable = join(appPath, "Contents/MacOS/VibeCab"),
  cli = join(appPath, "Contents/Resources/engine/bin/vibecab"),
  home = await mkdtemp(join(tmpdir(), "vibecab-app-smoke-home-")),
  workspace = join(home, "workspace"),
  env = {
    ...process.env,
    HOME: home,
    VIBECAB_DEV: "1",
    VIBECAB_KEYSTORE: "memory",
    VIBECAB_SMOKE: "1",
    VIBECAB_WORKSPACE_DIR: workspace,
  },
  app = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "",
  stderr = "";
app.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
app.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

function waitForReady() {
  return new Promise((resolveReady, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error("Packaged app did not report ready within 30 seconds.")),
      30_000,
    );
    const check = () => {
      if (stdout.split(/\r?\n/).includes("VIBECAB_READY")) {
        globalThis.clearTimeout(timeout);
        resolveReady();
      }
    };
    app.stdout.on("data", check);
    app.once("error", (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
    app.once("exit", (code, signal) => {
      globalThis.clearTimeout(timeout);
      reject(new Error(`Packaged app exited before ready (code ${String(code)}, signal ${String(signal)}).`));
    });
    check();
  });
}

async function stopApp() {
  if (app.exitCode !== null || app.signalCode !== null) return;
  app.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => app.once("exit", resolveExit)),
    new Promise((resolveTimeout) => globalThis.setTimeout(() => resolveTimeout(undefined), 5_000)),
  ]);
  if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
}

let failed = false;
try {
  await waitForReady();
  process.stdout.write("Packaged app reported ready.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (stderr) process.stderr.write(stderr);
} finally {
  await stopApp();
  try {
    execFileSync(cli, ["stop", "--workspace", workspace], { env, stdio: "ignore", timeout: 10_000 });
  } catch {
    // The host may not have started if the app failed before reporting ready.
  }
  await rm(home, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
