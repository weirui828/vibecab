import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebHost } from "./web-host.js";
import type { WebHostOptions } from "./web-host.js";
import { seedWorkspace } from "./seed.js";

/** Same default as the macOS app (`apps/macos/src/paths.ts`), so both open the same workspace. */
export function defaultWorkspace(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "VibeCab", "workspaces", "default");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "VibeCab", "workspaces", "default");
}

interface Args {
  workspace?: string;
  port: number;
  open: boolean;
  dev: boolean;
  fakeProvider?: string;
  tempWorkspace: boolean;
  seed: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { port: 4747, open: true, dev: false, tempWorkspace: false, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i],
      value = () => {
        const next = argv[++i];
        if (next === undefined) throw new Error(`${flag} needs a value`);
        return next;
      };
    if (flag === "--workspace") args.workspace = resolve(value());
    else if (flag === "--port") args.port = Number(value());
    else if (flag === "--no-open") args.open = false;
    else if (flag === "--dev") args.dev = true;
    else if (flag === "--fake-provider") args.fakeProvider = resolve(value());
    else if (flag === "--temp-workspace") args.tempWorkspace = true;
    else if (flag === "--seed") args.seed = true;
    else if (flag !== "--") throw new Error(`Unknown option ${flag}`);
  }
  const devOnly = args.fakeProvider !== undefined || args.tempWorkspace || args.seed;
  if (devOnly && process.env.VIBECAB_DEV !== "1")
    throw new Error("--fake-provider, --temp-workspace and --seed need VIBECAB_DEV=1");
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("Invalid --port");
  return args;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv),
    repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.."),
    workspace = args.tempWorkspace
      ? await mkdtemp(join(tmpdir(), "vibecab-web-"))
      : (args.workspace ?? defaultWorkspace());
  const options: WebHostOptions = {
    workspace,
    port: args.port,
    staticRoot: join(repo, "dist", "apps", "web", "client"),
    ...(args.fakeProvider ? { fakeProvider: args.fakeProvider } : {}),
  };
  if (args.dev) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: join(repo, "apps", "web", "vite.config.ts"),
      server: { middlewareMode: true, hmr: { port: args.port + 1 } },
      appType: "spa",
    });
    options.middleware = (req, res, next) => vite.middlewares(req, res, next);
  }
  const host = await startWebHost(options);
  const state = await host.engine.start();
  if (args.seed) await seedWorkspace(host.engine);
  const launch = host.launchUrl();
  process.stdout.write(`VibeCab is running at ${host.url} (engine: ${state}, workspace: ${workspace})\n`);
  process.stdout.write(`Open this link once to sign in this browser:\nVIBECAB_WEB_READY ${launch}\n`);
  if (args.open && process.platform === "darwin") execFile("open", [launch], () => undefined);
  const stop = () => void host.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
