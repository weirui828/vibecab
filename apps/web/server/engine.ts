import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, status, stop } from "../../../host/src/control.js";

export type ConnectionState = "Starting" | "Connected" | "Engine stopped" | "Engine unreachable";
export interface EngineInfo {
  startedAt: string;
  /** When the engine code on disk was built, if known. */
  builtAt?: string;
  /** The running engine started before that build: it runs older code. */
  outdated: boolean;
}
export interface EngineTarget {
  url: URL;
  token: string;
}

// Finds the workspace's engine through the shared host and keeps the app token on this side of the browser.
export class EngineLink {
  private cached: EngineTarget | undefined;

  constructor(
    readonly workspace: string,
    private readonly options: {
      fakeProvider?: string;
      /** When the engine code on disk was built (ms); found from the build output when not given (tests set it). */
      builtAt?: () => number | undefined;
    } = {},
  ) {}

  async target(): Promise<EngineTarget | undefined> {
    if (this.cached) return this.cached;
    const current = await status(this.workspace);
    if (!current.running) return undefined;
    this.cached = { url: new URL(current.httpUrl), token: await this.readToken() };
    return this.cached;
  }

  /** Forget the cached endpoint and token, e.g. after a refused connection or `unauthenticated`. */
  invalidate(): void {
    this.cached = undefined;
  }

  /** What Settings → About shows: when the engine started, when its code was built, and whether it is older. */
  async info(): Promise<EngineInfo | undefined> {
    const running = await status(this.workspace),
      builtAt = (this.options.builtAt ?? engineBuiltAt)();
    if (!running.running) return undefined;
    return {
      startedAt: running.startedAt,
      ...(builtAt !== undefined ? { builtAt: new Date(builtAt).toISOString() } : {}),
      outdated: builtAt !== undefined && Date.parse(running.startedAt) < builtAt,
    };
  }

  /** Stops the engine and starts it again with the code on disk (Settings → About → Restart engine). */
  async restart(): Promise<ConnectionState> {
    this.invalidate();
    await stop(this.workspace);
    return this.start();
  }

  async start(): Promise<ConnectionState> {
    this.invalidate();
    // An engine still running from before an update would refuse what the new app sends: replace it.
    const running = await status(this.workspace),
      builtAt = (this.options.builtAt ?? engineBuiltAt)();
    if (running.running && builtAt !== undefined && Date.parse(running.startedAt) < builtAt) await stop(this.workspace);
    await start(this.workspace, {
      nodePath: process.execPath,
      hostEntry: hostEntry(),
      ...(this.options.fakeProvider ? { fakeProvider: this.options.fakeProvider } : {}),
    });
    return this.state();
  }

  async state(): Promise<ConnectionState> {
    this.invalidate();
    const target = await this.target();
    if (!target) return "Engine stopped";
    try {
      const res = await fetch(new URL("/v1/capabilities", target.url), {
        headers: { Authorization: "Bearer " + target.token },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? "Connected" : "Engine unreachable";
    } catch {
      return "Engine unreachable";
    }
  }

  private async readToken(): Promise<string> {
    return (await readFile(join(this.workspace, ".vibecab", "app-token"), "utf8")).trim();
  }
}

/**
 * When the engine code the host runs was built: the engine module of the build that holds this host entry. The entry
 * is either `<repo>/host/bin/…` (beside `<repo>/dist/engine`) or `<repo>/dist/host/bin/…` (beside `<repo>/dist/engine`).
 */
export function engineBuiltAtFrom(entry: string): number | undefined {
  const base = dirname(dirname(dirname(entry)));
  for (const file of [join(base, "engine", "src", "engine.js"), join(base, "dist", "engine", "src", "engine.js")])
    if (existsSync(file)) return statSync(file).mtimeMs;
  return undefined;
}
const engineBuiltAt = () => engineBuiltAtFrom(hostEntry());

/** The host entry script, found from either the source tree (tests) or the build output. */
function hostEntry(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "host", "bin", "vibecab-host.mjs");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Cannot find host/bin/vibecab-host.mjs");
}
