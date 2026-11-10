#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const source = process.argv[2];
if (!source) throw Error("Usage: node scripts/vendor-design-system.mjs <path-to-design-system-repo>");
const repo = resolve(source),
  manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
if (manifest.name !== "@wei/design-system") throw Error("Path is not the @wei/design-system repository");
run("npm", ["run", "build"], repo);
run("npm", ["pack", "--pack-destination", resolve("vendor")], repo);
const tarball = (await readdir(resolve("vendor")))
  .filter((name) => name.startsWith("wei-design-system-") && name.endsWith(".tgz"))
  .sort()
  .at(-1);
if (!tarball) throw Error("npm pack did not create a design system tarball");
for (const app of ["apps/web"]) {
  const packagePath = resolve(app, "package.json"),
    appManifest = JSON.parse(await readFile(packagePath, "utf8"));
  appManifest.dependencies["@wei/design-system"] = `file:../../vendor/${tarball}`;
  await writeFile(packagePath, JSON.stringify(appManifest, null, 2) + "\n");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, npm_config_cache: "/private/tmp/vibecab-npm-cache" },
  });
  if (result.status !== 0) throw Error(`${command} ${args.join(" ")} failed`);
}
