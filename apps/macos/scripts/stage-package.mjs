import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleElectron } from "./bundle-electron.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(appRoot, "../..");
const stage = join(appRoot, "build/package");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const dist = join(stage, "dist"),
  renderer = join(root, "dist/apps/ui"),
  electronEntries = join(dist, "apps/macos/src");
await mkdir(electronEntries, { recursive: true });
await cp(renderer, join(dist, "apps/ui"), {
  recursive: true,
});
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
