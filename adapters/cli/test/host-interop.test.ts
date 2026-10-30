import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { start as startHost, status, stop } from "../../../host/src/index.js";
import { saveCliToken } from "../src/keychain.js";
import { main } from "../src/index.js";

it("shares one host between the library and CLI in both startup directions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-cli-host-")),
    hostEntry = join(workspace, "test-host.mjs"),
    input = join(workspace, "start-session.json"),
    output: string[] = [],
    errors: string[] = [],
    io = {
      writeOut: (value: string) => output.push(value),
      writeError: (value: string) => errors.push(value),
      readSecret: async () => "unused",
      writeBytes: () => undefined,
    };
  const previousDev = process.env.VIBECAB_DEV,
    previousEntry = process.env.VIBECAB_HOST_ENTRY;
  process.env.VIBECAB_DEV = "1";
  process.env.VIBECAB_HOST_ENTRY = hostEntry;
  try {
    await writeFile(
      hostEntry,
      `import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(resolve("."))};
const { createEngine } = await import(pathToFileURL(resolve(root, 'dist/engine/src/engine.js')));
const { startHttp } = await import(pathToFileURL(resolve(root, 'dist/adapters/http/src/index.js')));
const { CONTRACT_VERSION } = await import(pathToFileURL(resolve(root, 'dist/contract/src/index.js')));
const workspace = resolve(process.argv[process.argv.indexOf('--workspace') + 1]);
const engine = createEngine();
await engine.start(workspace);
const created = await engine.command(
  engine.inProcessAuth,
  { contractVersion: CONTRACT_VERSION, requestId: 'interop-token' },
  {
    commandId: 'interop-token-' + process.pid,
    type: 'sys.CreateAccessToken',
    payload: { name: 'CLI interop', channel: 'cli', scope: 'admin' }
  }
);
if (!created.ok) throw new Error(created.error.message);
const token = created.result.token;
const directory = join(workspace, '.vibecab');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'cli-token.test-only'), token, { mode: 0o600 });
const server = await startHttp(engine, { transport: 'cli' });
const serverFile = join(directory, 'server.json');
await writeFile(
  serverFile,
  JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    contractVersion: CONTRACT_VERSION,
    httpUrl: server.url,
    cliUrl: server.url,
    mcpUrl: server.url
  }),
  { mode: 0o600 }
);
process.once('SIGTERM', () => void (async () => {
  await server.close();
  await engine.stop();
  await rm(serverFile, { force: true });
  process.exit(0);
})());
await new Promise(() => setInterval(() => undefined, 1000));\n`,
    );
    await writeFile(input, JSON.stringify({ title: "Started through the host" }));
    const libraryStarted = await startHost(workspace, { nodePath: process.execPath, hostEntry });
    if (!libraryStarted.running) throw new Error("Library host did not start");
    expect(await main(["status", "--workspace", workspace], io)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "null")).toMatchObject({ running: true, pid: libraryStarted.pid });

    const token = await readFile(join(workspace, ".vibecab", "cli-token.test-only"), "utf8");
    await saveCliToken(workspace, token);
    expect(await main(["cmd", "vc.StartSession", "--json", input, "--workspace", workspace], io)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "null")).toHaveProperty("sessionId");
    expect(await main(["stop", "--workspace", workspace], io)).toBe(0);
    expect((await status(workspace)).running).toBe(false);

    expect(await main(["start", "--workspace", workspace], io)).toBe(0);
    expect((await status(workspace)).running).toBe(true);
    await stop(workspace);
    expect(errors).toEqual([]);
  } finally {
    await stop(workspace).catch(() => undefined);
    if (previousDev === undefined) delete process.env.VIBECAB_DEV;
    else process.env.VIBECAB_DEV = previousDev;
    if (previousEntry === undefined) delete process.env.VIBECAB_HOST_ENTRY;
    else process.env.VIBECAB_HOST_ENTRY = previousEntry;
    await rm(workspace, { recursive: true, force: true });
  }
});
