import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, status } from "../../../host/src/control.js";

export type ConnectionState = "Starting" | "Connected" | "Engine stopped" | "Engine unreachable";
export interface EngineTarget {
  url: URL;
  token: string;
}

// Finds the workspace's engine through the shared host and keeps the app token on this side of the browser.
export class EngineLink {
  private cached: EngineTarget | undefined;

  constructor(
    readonly workspace: string,
    private readonly options: { fakeProvider?: string } = {},
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

  async start(): Promise<ConnectionState> {
    this.invalidate();
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
