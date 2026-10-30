import { Entry } from "@napi-rs/keyring";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION, Contract } from "../../contract/src/index.js";
import type { Engine } from "../../engine/src/engine.js";
import { createEngine } from "../../engine/src/engine.js";
import { ScriptedProvider } from "../../engine/src/gateway/fake.js";
import type { ModelEvent } from "../../engine/src/gateway/types.js";
import { startHttp } from "../../adapters/http/src/index.js";
import { startMcpHttp } from "../../adapters/mcp-server/src/index.js";

const service = "VibeCab";
function tokenMap(account: string): Record<string, string> {
  try {
    const raw = new Entry(service, account).getPassword();
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export async function ensureToken(engine: Engine, workspace: string, account: "app" | "cli"): Promise<void> {
  const tokens = tokenMap(account),
    token = tokens[workspace],
    transport = account === "app" ? "http" : "cli";
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
      commandId: `host-app-token-${Date.now()}`,
      type: "sys.CreateAccessToken",
      payload: { name: account === "app" ? "VibeCab app" : "VibeCab CLI", channel: transport, scope: "admin" },
    },
  );
  if (!created.ok) throw Error(created.error.message);
  const tokenValue = new Contract().read<{ token: string }>(
    "operations/sys.CreateAccessToken",
    created.result,
    "#/properties/result",
  ).token;
  new Entry(service, account).setPassword(JSON.stringify({ ...tokens, [workspace]: tokenValue }));
}

export async function serve(workspaceDir: string, fakeProviderPath?: string): Promise<void> {
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
  }
  const workspace = resolve(workspaceDir),
    engine = createEngine(fakeProviderPath ? { modelProviders: providers } : {});
  await engine.start(workspace);
  let http: Awaited<ReturnType<typeof startHttp>> | undefined,
    cli: Awaited<ReturnType<typeof startHttp>> | undefined,
    mcp: Awaited<ReturnType<typeof startMcpHttp>> | undefined;
  const serverFile = join(workspace, ".vibecab", "server.json");
  try {
    await ensureToken(engine, workspace, "app");
    await ensureToken(engine, workspace, "cli");
    http = await startHttp(engine, { port: 0, transport: "http" });
    cli = await startHttp(engine, { port: 0, transport: "cli" });
    mcp = await startMcpHttp(engine, { port: 0 });
    await mkdir(join(workspace, ".vibecab"), { recursive: true, mode: 0o700 });
    const record = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      contractVersion: CONTRACT_VERSION,
      httpUrl: http.url,
      cliUrl: cli.url,
      mcpUrl: mcp.url,
    };
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
