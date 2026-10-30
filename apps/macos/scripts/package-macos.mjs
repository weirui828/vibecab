import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(appRoot, "../..");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}
await rm(resolve(root, "dist"), { recursive: true, force: true });
run("pnpm", ["build"]);
run(process.execPath, [resolve(appRoot, "scripts/generate-icons.mjs")]);
await rm(resolve(appRoot, "build/engine-deploy"), { recursive: true, force: true });
run("pnpm", ["deploy", "--filter", "@vibecab/host", "--prod", resolve(appRoot, "build/engine-deploy")]);
run(process.execPath, [resolve(appRoot, "scripts/stage-package.mjs")]);
run(
  "pnpm",
  [
    "--filter",
    "@vibecab/macos",
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.mjs",
    "--mac",
    "--publish",
    "never",
  ],
  appRoot,
);
