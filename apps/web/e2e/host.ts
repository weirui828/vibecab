import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");

export interface E2EHost {
  url: string;
  launch: string;
  workspace: string;
  stop(): Promise<void>;
}

/**
 * Starts the built web host (`pnpm build` first) on a fresh workspace with the scripted model, the way a person
 * would with `vibecab-web`, and returns its one-time sign-in link.
 */
export async function startE2EHost(port: number): Promise<E2EHost> {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-web-e2e-"));
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(repo, "apps/web/bin/vibecab-web.mjs"),
      "--workspace",
      workspace,
      "--fake-provider",
      join(repo, "apps/web/dev/fake-provider.json"),
      "--no-open",
      "--port",
      String(port),
    ],
    { env: { ...process.env, VIBECAB_DEV: "1", VIBECAB_KEYSTORE: "memory" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const launch = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("web host did not start:\n" + output)), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /VIBECAB_WEB_READY (\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => fail(new Error(`web host exited (${code}):\n` + output)));
  });
  return {
    url: "http://127.0.0.1:" + port,
    launch,
    workspace,
    async stop() {
      child.kill("SIGTERM");
      // The engine runs as its own detached host process; stop it through its runtime file.
      try {
        const server = JSON.parse(await readFile(join(workspace, ".vibecab", "server.json"), "utf8")) as {
          pid: number;
        };
        process.kill(server.pid, "SIGTERM");
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 500));
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
