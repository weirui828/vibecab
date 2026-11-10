import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPackage } from "@electron/asar";
import { expect, it } from "vitest";

it("declares an arm64 macOS app and a one-command packaging script", async () => {
  const root = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    },
    mac = await readFile(new URL("../electron-builder.config.mjs", import.meta.url), "utf8");
  expect(root.scripts["app:package"]).toBeDefined();
  expect(mac).toContain('appId: "app.vibecab.mac"');
  expect(mac).toContain('minimumSystemVersion: "14.0"');
  expect(mac).toContain('{ target: "dmg", arch: ["arm64"] }');
  expect(mac).toContain('{ target: "dir", arch: ["arm64"] }');
});

const packagedApp = process.env.VIBECAB_PACKAGED_APP;

it.skipIf(!packagedApp)("packs only the shell's main into app.asar; the web app ships beside the engine", async () => {
  const archive = join(packagedApp!, "Contents/Resources/app.asar"),
    files = listPackage(archive, { isPack: false }).map((path) => path.replace(/^\//, ""));
  expect(files).toContain("dist/apps/macos/src/main.mjs");
  expect(files.some((path) => /preload/.test(path))).toBe(false);
  expect((await stat(join(packagedApp!, "Contents/Resources/engine/dist/apps/web/client/index.html"))).isFile()).toBe(
    true,
  );
});

it.skipIf(!packagedApp)("runs the packaged Node CLI against a fresh temporary workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-packaged-engine-")),
    cli = join(packagedApp!, "Contents/Resources/engine/bin/vibecab"),
    env = { ...process.env, VIBECAB_DEV: "1", VIBECAB_KEYSTORE: "memory" };
  try {
    execFileSync(cli, ["start", "--workspace", workspace], { encoding: "utf8", env, timeout: 60_000 });
    const status = JSON.parse(
      execFileSync(cli, ["status", "--workspace", workspace], { encoding: "utf8", env, timeout: 15_000 }),
    ) as { running: boolean };
    expect(status.running).toBe(true);
    expect((await stat(join(workspace, "workspace.sqlite"))).isFile()).toBe(true);
  } finally {
    try {
      execFileSync(cli, ["stop", "--workspace", workspace], { encoding: "utf8", env, timeout: 30_000 });
    } catch {
      // Startup may fail before the helper creates a running host.
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
