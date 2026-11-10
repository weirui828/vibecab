import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleElectron } from "./bundle-electron.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(appRoot, "build/package");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
// The app holds only the shell's main entry: the web app it shows ships beside the engine (afterPack copies the
// whole build output to Resources/engine/dist), and the web host inside main serves it from there.
const electronEntries = join(stage, "dist/apps/macos/src");
await mkdir(electronEntries, { recursive: true });
await bundleElectron(join(appRoot, "src"), electronEntries);
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "vibecab-macos",
      productName: "VibeCab",
      version: "0.1.0",
      main: "dist/apps/macos/src/main.mjs",
      private: true,
    },
    null,
    2,
  ) + "\n",
);
