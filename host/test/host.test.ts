import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { start, status, stop } from "../src/index.js";

const fakeHost = `
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2), workspace = args[args.indexOf('--workspace') + 1], dir = join(workspace, '.vibecab'), file = join(dir, 'server.json');
await mkdir(dir, { recursive: true });
await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), contractVersion: '1.0', httpUrl: 'http://127.0.0.1:1', cliUrl: 'http://127.0.0.1:2', mcpUrl: 'http://127.0.0.1:3' }), { mode: 0o600 });
process.once('SIGTERM', async () => { await rm(file, { force: true }); process.exit(0); });
await new Promise(() => setInterval(() => undefined, 1000));
`;

it("shares a concurrently started host and replaces a stale runtime record", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-host-")),
    hostEntry = join(workspace, "fake-host.mjs");
  await writeFile(hostEntry, fakeHost);
  try {
    const [first, second] = await Promise.all([
      start(workspace, { nodePath: process.execPath, hostEntry }),
      start(workspace, { nodePath: process.execPath, hostEntry }),
    ]);
    expect(first).toEqual(second);
    expect((await status(workspace)).running).toBe(true);
    await stop(workspace);
    await writeFile(
      join(workspace, ".vibecab", "server.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: "2026-01-01T00:00:00.000Z",
        contractVersion: "1.0",
        httpUrl: "http://127.0.0.1:1",
        cliUrl: "http://127.0.0.1:2",
        mcpUrl: "http://127.0.0.1:3",
      }),
    );
    const restarted = await start(workspace, { nodePath: process.execPath, hostEntry });
    expect(restarted.running).toBe(true);
    if (!restarted.running) throw Error("Host did not restart");
    expect(restarted.pid).not.toBe(2_147_483_647);
    await stop(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
