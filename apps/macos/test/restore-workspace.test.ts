import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { switchWorkspaceFromBackup } from "../src/restore-workspace.js";
import { ctx, fixture } from "../../../engine/test/helpers.js";
import { restoreBackup } from "../../../host/src/entry.js";
import { Contract } from "../../../contract/src/index.js";
import type { BackupRecord } from "../../../contract/src/index.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

it("switches to a verified backup workspace and keeps the former workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecab-restore-switch-"));
  directories.push(parent);
  const workspace = join(parent, "default");
  await writeFile(join(await makeDirectory(workspace), "marker"), "original");
  let running = true;
  const archived = await switchWorkspaceFromBackup({
    workspace,
    archive: "verified.tgz",
    now: new Date("2026-10-30T12:00:00.000Z"),
    stop: async () => {
      running = false;
    },
    restore: async (_archive, destination) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(destination);
      await writeFile(join(destination, "marker"), "restored");
    },
    start: async () => {
      running = true;
    },
  });
  expect(running).toBe(true);
  expect(await readFile(join(workspace, "marker"), "utf8")).toBe("restored");
  expect(await readFile(join(archived, "marker"), "utf8")).toBe("original");
});

it("restores the original workspace and restarts it when archive verification fails", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecab-restore-failure-"));
  directories.push(parent);
  const workspace = join(parent, "default");
  await writeFile(join(await makeDirectory(workspace), "marker"), "original");
  let starts = 0,
    running = true;
  await expect(
    switchWorkspaceFromBackup({
      workspace,
      archive: "tampered.tgz",
      now: new Date("2026-10-30T12:00:00.000Z"),
      stop: async () => {
        running = false;
      },
      restore: async () => {
        throw new Error("Backup verification failed");
      },
      start: async () => {
        starts++;
        running = true;
      },
    }),
  ).rejects.toThrow("Backup verification failed");
  expect(running).toBe(true);
  expect(starts).toBe(1);
  expect(await readFile(join(workspace, "marker"), "utf8")).toBe("original");
});

it("keeps the original running workspace when the real backup verifier rejects a tampered archive", async () => {
  const source = await fixture(),
    parent = await mkdtemp(join(tmpdir(), "vibecab-restore-host-flow-"));
  directories.push(parent);
  try {
    const queued = await source.engine.command(ctx, {
      commandId: "macos-backup-for-restore",
      type: "sys.Backup",
      payload: {},
    });
    if (!queued.ok) throw Error(queued.error.message);
    const { backupId } = new Contract().read<{ backupId: string }>(
      "operations/sys.Backup",
      queued.result,
      "#/properties/result",
    );
    let archive = "";
    for (let attempt = 0; attempt < 100 && !archive; attempt++) {
      const backups = new Contract().read<BackupRecord[]>(
        "operations/sys.Backups",
        await source.engine.query(ctx, { name: "sys.Backups", args: {} }),
        "#/properties/result",
      );
      archive = backups.find((item) => item.backupId === backupId)?.archivePath ?? "";
      if (!archive) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(archive).not.toBe("");
    const tampered = join(parent, "tampered.tgz"),
      workspace = join(parent, "default");
    await writeFile(tampered, "tampered archive");
    await writeFile(join(await makeDirectory(workspace), "marker"), "original");
    let running = true;
    await expect(
      switchWorkspaceFromBackup({
        workspace,
        archive: tampered,
        stop: async () => {
          running = false;
        },
        restore: restoreBackup,
        start: async () => {
          running = true;
        },
      }),
    ).rejects.toThrow();
    expect(running).toBe(true);
    expect(await readFile(join(workspace, "marker"), "utf8")).toBe("original");
  } finally {
    await source.close();
  }
});

async function makeDirectory(path: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path);
  return path;
}
