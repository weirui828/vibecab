import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { status, stop } from "../../../host/src/control.js";
import { EngineLink } from "../server/engine.js";
import { fakeProvider } from "./helpers.js";

// After an update, `pnpm web` used to reuse the engine still running from before it, which then refused anything
// the new app sent (Wei: "VibeCab could not do this" on Use Claude Code). Launch now restarts an engine older than
// the engine code on disk.
let workspace = "";
afterAll(async () => {
  if (workspace) {
    await stop(workspace).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
});

it("restarts an engine that started before the engine code was built, and keeps a current one", async () => {
  workspace = await mkdtemp(join(tmpdir(), "vibecab-engine-link-"));
  const first = new EngineLink(workspace, { fakeProvider, builtAt: () => 0 });
  expect(await first.start()).toBe("Connected");
  const before = await status(workspace);
  if (!before.running) throw Error("engine did not start");
  // Built before the engine started: the running one is current and is kept.
  await new EngineLink(workspace, { fakeProvider, builtAt: () => Date.parse(before.startedAt) - 1000 }).start();
  const kept = await status(workspace);
  expect(kept.running && kept.pid).toBe(before.pid);
  // Built after it started: launch replaces it with one running the new code.
  const relaunch = new EngineLink(workspace, { fakeProvider, builtAt: () => Date.parse(before.startedAt) + 1000 });
  expect(await relaunch.start()).toBe("Connected");
  const after = await status(workspace);
  expect(after.running && after.pid).not.toBe(before.pid);
}, 60_000);

it("finds when the engine code was built, whether the host runs from the repository or from the build", async () => {
  const { mkdir, writeFile, utimes } = await import("node:fs/promises");
  const { engineBuiltAtFrom } = await import("../server/engine.js");
  const repo = await mkdtemp(join(tmpdir(), "vibecab-layout-"));
  try {
    await mkdir(join(repo, "dist", "engine", "src"), { recursive: true });
    await writeFile(join(repo, "dist", "engine", "src", "engine.js"), "");
    await utimes(join(repo, "dist", "engine", "src", "engine.js"), 1_700_000_000, 1_700_000_000);
    // From the repository: <repo>/host/bin/vibecab-host.mjs
    expect(engineBuiltAtFrom(join(repo, "host", "bin", "vibecab-host.mjs"))).toBe(1_700_000_000_000);
    // From the build: <repo>/dist/host/bin/vibecab-host.mjs — the case that used to find nothing.
    expect(engineBuiltAtFrom(join(repo, "dist", "host", "bin", "vibecab-host.mjs"))).toBe(1_700_000_000_000);
    expect(engineBuiltAtFrom(join(tmpdir(), "nowhere", "host", "bin", "x.mjs"))).toBeUndefined();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
