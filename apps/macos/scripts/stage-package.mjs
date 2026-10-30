import { mkdir, rm, writeFile, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(appRoot, "../..");
const stage = join(appRoot, "build/package");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, "dist"), join(stage, "dist"), {
  recursive: true,
  filter: (source) => !source.split("/").includes("node_modules"),
});
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "vibecab-macos",
      productName: "VibeCab",
      version: "0.1.0",
      main: "dist/apps/macos/src/main.js",
      private: true,
    },
    null,
    2,
  ) + "\n",
);
