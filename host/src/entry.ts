import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION, Contract } from "../../contract/src/index.js";
import type { Engine } from "../../engine/src/engine.js";
import { createEngine } from "../../engine/src/engine.js";
import { createKeyStoreFromEnvironment } from "../../engine/src/gateway/keys.js";
import type { KeyStore } from "../../engine/src/gateway/types.js";
import { ScriptedProvider } from "../../engine/src/gateway/fake.js";
import type { ModelEvent } from "../../engine/src/gateway/types.js";
import { startHttp } from "../../adapters/http/src/index.js";
import { startMcpHttp } from "../../adapters/mcp-server/src/index.js";

export interface ServerRecord {
  pid: number;
  startedAt: string;
  contractVersion: string;
  httpUrl: string;
  cliUrl: string;
  mcpUrl: string;
}

export function createServerRecord(
  pid: number,
  startedAt: string,
  contractVersion: string,
  httpUrl: string,
  cliUrl: string,
  mcpUrl: string,
): ServerRecord {
  return { pid, startedAt, contractVersion, httpUrl, cliUrl, mcpUrl };
}

async function tokenMap(keyStore: KeyStore, account: string): Promise<Record<string, string>> {
  try {
    const raw = await keyStore.get(account);
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export async function ensureToken(
  engine: Engine,
  workspace: string,
  account: "app" | "cli",
  keyStore: KeyStore = createKeyStoreFromEnvironment(),
): Promise<void> {
  if (account === "app") return ensureAppToken(engine, workspace, keyStore);
  const tokens = await tokenMap(keyStore, account),
    token = tokens[workspace],
    transport = "cli";
  if (token) {
    try {
      await engine.query(
        { kind: "token", secret: token, transport },
        {
          contractVersion: CONTRACT_VERSION,
          requestId: "host-token-check",
        },
        { name: "sys.Capabilities", args: {} },
      );
      return;
    } catch {
      // A revoked or unknown keychain token is replaced with a fresh engine token.
    }
  }
  const created = await engine.command(
    engine.inProcessAuth,
    {
      contractVersion: CONTRACT_VERSION,
      requestId: "host-app-token",
    },
    {
      commandId: `host-cli-token-${randomUUID()}`,
      type: "sys.CreateAccessToken",
      payload: { name: "VibeCab CLI", channel: transport, scope: "admin" },
    },
  );
  if (!created.ok) throw Error(created.error.message);
  const tokenValue = tokenSecret(created.result);
  try {
    keyStore.set(account, JSON.stringify({ ...tokens, [workspace]: tokenValue }));
  } catch {
    console.warn("CLI access token could not be saved.");
  }
}

async function ensureAppToken(engine: Engine, workspace: string, keyStore: KeyStore): Promise<void> {
  const legacyTokens = await tokenMap(keyStore, "app"),
    legacyToken = legacyTokens[workspace],
    appDir = join(workspace, ".vibecab"),
    tokenPath = join(appDir, "app-token");
  await mkdir(appDir, { recursive: true, mode: 0o700 });
  await chmod(appDir, 0o700);

  const storedToken = await readAppToken(tokenPath);
  if (storedToken && (await verifies(engine, storedToken, "http"))) {
    await removeLegacyAppToken(workspace, legacyTokens, keyStore);
    return;
  }
  if (legacyToken && (await verifies(engine, legacyToken, "http"))) {
    await writeAppToken(tokenPath, appDir, legacyToken);
    await removeLegacyAppToken(workspace, legacyTokens, keyStore);
    return;
  }

  const token = await createToken(engine, "http", "VibeCab app");
  await writeAppToken(tokenPath, appDir, token);
  await removeLegacyAppToken(workspace, legacyTokens, keyStore);
}

async function readAppToken(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) {
      console.warn("App token file is not a regular file; replacing it.");
      return undefined;
    }
    if ((info.mode & 0o777) !== 0o600) {
      console.warn("App token file permissions were too broad; securing the file.");
      await chmod(path, 0o600);
    }
    const secured = await lstat(path);
    if ((secured.mode & 0o077) !== 0) {
      console.warn("App token file could not be secured; replacing it.");
      return undefined;
    }
    const token = await readFile(path, "utf8");
    return token.length > 0 && token.trim() === token ? token : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    console.warn("App token file could not be read; replacing it.");
    return undefined;
  }
}

async function writeAppToken(path: string, directory: string, token: string): Promise<void> {
  const temporaryPath = join(directory, `.app-token.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(token, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function removeLegacyAppToken(
  workspace: string,
  tokens: Record<string, string>,
  keyStore: KeyStore,
): Promise<void> {
  if (!Object.hasOwn(tokens, workspace)) return;
  const remaining = { ...tokens };
  delete remaining[workspace];
  if (Object.keys(remaining).length === 0) await keyStore.delete("app");
  else keyStore.set("app", JSON.stringify(remaining));
}

async function verifies(engine: Engine, token: string, transport: "http"): Promise<boolean> {
  try {
    await engine.query(
      { kind: "token", secret: token, transport },
      { contractVersion: CONTRACT_VERSION, requestId: "host-token-check" },
      { name: "sys.Capabilities", args: {} },
    );
    return true;
  } catch {
    return false;
  }
}

async function createToken(engine: Engine, transport: "http", name: string): Promise<string> {
  const created = await engine.command(
    engine.inProcessAuth,
    { contractVersion: CONTRACT_VERSION, requestId: "host-app-token" },
    {
      commandId: `host-${transport}-token-${randomUUID()}`,
      type: "sys.CreateAccessToken",
      payload: { name, channel: transport, scope: "admin" },
    },
  );
  if (!created.ok) throw Error(created.error.message);
  return tokenSecret(created.result);
}

function tokenSecret(result: unknown): string {
  return new Contract().read<{ token: string }>("operations/sys.CreateAccessToken", result, "#/properties/result")
    .token;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function serve(
  workspaceDir: string,
  fakeProviderPath?: string,
  keyStore: KeyStore = createKeyStoreFromEnvironment(),
): Promise<void> {
  if (fakeProviderPath && process.env.VIBECAB_DEV !== "1") throw Error("--fake-provider requires VIBECAB_DEV=1");
  const providers: Record<string, ScriptedProvider> = {};
  if (fakeProviderPath) {
    const parsed: unknown = JSON.parse(await readFile(resolve(fakeProviderPath), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Invalid fake provider script");
    const provider = new ScriptedProvider(),
      sequence = Reflect.get(parsed, "defaultSequence");
    if (!Array.isArray(sequence) || sequence.some((turn) => !Array.isArray(turn) || !turn.every(isModelEvent)))
      throw Error("Invalid fake provider script");
    for (const turn of sequence) provider.enqueueDefaultSequence([turn]);
    providers["vibecab-fake"] = provider;
    providers["openai-compatible"] = provider;
    // In development and tests, Claude Code and Codex answer from the same script: no real SDK ever starts.
    providers["claude-agent-sdk"] = provider;
    providers["codex-sdk"] = provider;
  }
  const workspace = resolve(workspaceDir),
    engine = createEngine({ ...(fakeProviderPath ? { modelProviders: providers } : {}), keyStore });
  await engine.start(workspace);
  let http: Awaited<ReturnType<typeof startHttp>> | undefined,
    cli: Awaited<ReturnType<typeof startHttp>> | undefined,
    mcp: Awaited<ReturnType<typeof startMcpHttp>> | undefined;
  const serverFile = join(workspace, ".vibecab", "server.json");
  try {
    await ensureToken(engine, workspace, "app", keyStore);
    await ensureToken(engine, workspace, "cli", keyStore);
    http = await startHttp(engine, { port: 0, transport: "http" });
    cli = await startHttp(engine, { port: 0, transport: "cli" });
    mcp = await startMcpHttp(engine, { port: 0 });
    await mkdir(join(workspace, ".vibecab"), { recursive: true, mode: 0o700 });
    const record = createServerRecord(
      process.pid,
      new Date().toISOString(),
      CONTRACT_VERSION,
      http.url,
      cli.url,
      mcp.url,
    );
    await writeFile(serverFile, JSON.stringify(record), { mode: 0o600 });
    let stopping: Promise<void> | undefined;
    const shutdown = () => {
      stopping ??= (async () => {
        await Promise.all([http?.close(), cli?.close(), mcp?.close()]);
        await engine.drain(30_000);
        await engine.stop();
        await rm(serverFile, { force: true });
      })();
      return stopping;
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    await new Promise<void>((resolveExit) => process.once("beforeExit", resolveExit));
    await shutdown();
  } catch (error) {
    await Promise.all([http?.close(), cli?.close(), mcp?.close()]);
    await engine.stop();
    throw error;
  }
}

export async function restoreBackup(archivePath: string, destinationDir: string): Promise<void> {
  const engine = createEngine({ keyStore: createKeyStoreFromEnvironment() });
  try {
    await engine.restoreBackup(resolve(archivePath), resolve(destinationDir));
  } finally {
    await engine.stop();
  }
}

function isModelEvent(value: unknown): value is ModelEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = Reflect.get(value, "type");
  if (type === "text_delta") return typeof Reflect.get(value, "text") === "string";
  if (type === "tool_call") return typeof Reflect.get(value, "call") === "object";
  if (type === "output") return Reflect.has(value, "json");
  if (type === "usage") return ["reported", "estimated", "unknown"].includes(String(Reflect.get(value, "quality")));
  if (type === "done")
    return ["stop", "length", "tool_calls", "content_filter", "error"].includes(
      String(Reflect.get(value, "finishReason")),
    );
  if (type === "error")
    return (
      ["provider_error", "rate_limited", "auth", "unsupported", "timeout", "cancelled"].includes(
        String(Reflect.get(value, "code")),
      ) &&
      typeof Reflect.get(value, "message") === "string" &&
      typeof Reflect.get(value, "retryable") === "boolean"
    );
  return false;
}
