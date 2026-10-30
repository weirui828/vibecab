import { chmod, cp, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { configurePackagedFuses } from "./fuses.mjs";
import { prepareEngineNodeModules } from "./scripts/prepare-engine-node-modules.mjs";

const appRoot = import.meta.dirname;

async function afterPack(context) {
  const appPath = join(context.appOutDir, "VibeCab.app");
  const resources = join(appPath, "Contents", "Resources");
  const engine = join(resources, "engine");
  const deploy = join(appRoot, "build/engine-deploy");
  await mkdir(join(engine, "bin"), { recursive: true });
  await cp(resolve(appRoot, "../../dist"), join(engine, "dist"), {
    recursive: true,
    force: true,
    filter: (source) => !source.split("/").includes("node_modules"),
  });
  await cp(join(deploy, "node_modules"), join(engine, "node_modules"), {
    recursive: true,
    dereference: true,
    force: true,
  });
  await prepareEngineNodeModules(join(engine, "node_modules"));
  const nodeSource = resolve(appRoot, "../../node_modules/.pnpm/node@26.13.0/node_modules/node/bin/node");
  const nodeTarget = join(engine, "bin/node");
  await cp(nodeSource, nodeTarget);
  await chmod(nodeTarget, 0o755);
  execFileSync("strip", ["-S", "-x", nodeTarget]);
  execFileSync("codesign", ["--force", "--sign", "-", nodeTarget]);
  if (execFileSync(nodeTarget, ["--version"], { encoding: "utf8" }).trim() !== "v26.13.0")
    throw new Error("The bundled Node helper must remain Node 26.13.0 after stripping.");
  for (const [source, target] of [
    ["iconTemplate.png", "iconTemplate.png"],
    ["iconTemplate@2x.png", "iconTemplate@2x.png"],
  ])
    await cp(join(appRoot, "build", source), join(engine, target));
  await cp(join(appRoot, "scripts/packaged-vibecab"), join(engine, "bin/vibecab"));
  await cp(join(appRoot, "scripts/packaged-vibecab-mcp"), join(engine, "bin/vibecab-mcp"));
  await cp(join(appRoot, "scripts/cli.mjs"), join(engine, "bin/cli.mjs"));
  await cp(join(appRoot, "scripts/mcp.mjs"), join(engine, "bin/mcp.mjs"));
  await cp(resolve(appRoot, "../../host/bin/vibecab-host.mjs"), join(engine, "bin/vibecab-host.mjs"));
  await chmod(join(engine, "bin/vibecab"), 0o755);
  await chmod(join(engine, "bin/vibecab-mcp"), 0o755);
  await configurePackagedFuses(appPath);
}

export default {
  appId: "app.vibecab.mac",
  productName: "VibeCab",
  directories: { app: "build/package", output: "../../release", buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  electronVersion: "45.1.0",
  electronLanguages: ["en-US"],
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "dir", arch: ["arm64"] },
    ],
    minimumSystemVersion: "14.0",
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    identity: "-",
    extendInfo: { LSMinimumSystemVersion: "14.0" },
  },
  afterPack,
};
