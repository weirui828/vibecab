import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface RestoreWorkspaceOptions {
  workspace: string;
  archive: string;
  restore: (archive: string, destination: string) => Promise<void>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  now?: Date;
}

export async function switchWorkspaceFromBackup(options: RestoreWorkspaceOptions): Promise<string> {
  const parent = dirname(options.workspace),
    stamp = (options.now ?? new Date()).toISOString().replaceAll(":", "-").replaceAll(".", "-"),
    originalName = basename(options.workspace),
    staged = join(parent, `restore-${stamp}`),
    backup = join(parent, `${originalName}-before-restore-${stamp}`),
    failed = join(parent, `restore-failed-${stamp}`);
  await mkdir(parent, { recursive: true });
  await options.stop();
  try {
    await options.restore(options.archive, staged);
    await rename(options.workspace, backup);
    try {
      await rename(staged, options.workspace);
      await options.start();
      return backup;
    } catch (error) {
      await options.stop().catch(() => undefined);
      await rename(options.workspace, failed).catch(() => undefined);
      await rename(backup, options.workspace);
      await options.start();
      throw error;
    }
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    await options.start().catch(() => undefined);
    throw error;
  }
}
