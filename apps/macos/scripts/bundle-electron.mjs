import { builtinModules } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const externalBuiltins = builtinModules.flatMap((name) => [name, `node:${name}`]);

/** Bundles the shell's one entry, main. There is no preload: the page gets nothing from Electron. */
export async function bundleElectron(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory),
    output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const main = await build({
    absWorkingDir: source,
    entryPoints: [join(source, "main.ts")],
    outfile: join(output, "main.mjs"),
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    external: ["electron", ...externalBuiltins],
    metafile: true,
  });
  return { metafile: main.metafile };
}
