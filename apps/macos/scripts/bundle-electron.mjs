import { builtinModules } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const externalBuiltins = builtinModules.flatMap((name) => [name, `node:${name}`]);

export async function bundleElectron(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory),
    output = resolve(outputDirectory),
    external = ["electron", ...externalBuiltins];
  await mkdir(output, { recursive: true });
  const [main, preload] = await Promise.all([
    build({
      absWorkingDir: source,
      entryPoints: [join(source, "main.ts")],
      outfile: join(output, "main.mjs"),
      bundle: true,
      platform: "node",
      target: "node26",
      format: "esm",
      external,
      metafile: true,
    }),
    build({
      absWorkingDir: source,
      entryPoints: [join(source, "preload.cts")],
      outfile: join(output, "preload.cjs"),
      bundle: true,
      platform: "node",
      target: "node26",
      format: "cjs",
      external,
      metafile: true,
    }),
  ]);
  return {
    metafile: {
      inputs: { ...main.metafile.inputs, ...preload.metafile.inputs },
      outputs: { ...main.metafile.outputs, ...preload.metafile.outputs },
    },
  };
}
