import { appendFileSync, writeFileSync } from "node:fs";

export function configureSmokeArguments(args: string[], env: NodeJS.ProcessEnv): void {
  if (!args.includes("--vibecab-smoke")) return;
  env.VIBECAB_SMOKE = "1";
  env.VIBECAB_DEV = "1";
  env.VIBECAB_KEYSTORE = "memory";
  const options = [
    ["vibecab-workspace", "VIBECAB_WORKSPACE_DIR"],
    ["vibecab-smoke-ready-file", "VIBECAB_SMOKE_READY_FILE"],
    ["vibecab-smoke-pid-file", "VIBECAB_SMOKE_PID_FILE"],
    ["vibecab-smoke-log-file", "VIBECAB_SMOKE_LOG_FILE"],
  ] as const;
  for (const [argument, variable] of options) {
    const prefix = `--${argument}=`,
      value = args.find((item) => item.startsWith(prefix))?.slice(prefix.length);
    if (value) env[variable] = value;
  }
}

export function installSmokeHooks(env: NodeJS.ProcessEnv, exit: (code: number) => void): void {
  if (env.VIBECAB_SMOKE !== "1") return;
  const pidPath = env.VIBECAB_SMOKE_PID_FILE,
    logPath = env.VIBECAB_SMOKE_LOG_FILE;
  if (pidPath) writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
  const fail = (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (logPath) appendFileSync(logPath, `uncaught exception: ${message}\n`);
    console.error(error);
    exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}

export function markSmokeReady(env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream): void {
  stdout.write("VIBECAB_READY\n");
  const readyPath = env.VIBECAB_SMOKE_READY_FILE;
  if (readyPath) writeFileSync(readyPath, `VIBECAB_READY\n${process.pid}\n`, { mode: 0o600 });
}

export function recordSmokeConsoleMessage(env: NodeJS.ProcessEnv, message: string): void {
  const logPath = env.VIBECAB_SMOKE_LOG_FILE;
  if (env.VIBECAB_SMOKE === "1" && logPath && /No handler registered|uncaught/i.test(message))
    appendFileSync(logPath, `${message}\n`);
}
