import { builtinModules } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bundleElectron } from "../scripts/bundle-electron.mjs";

const builtinNames = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

it("bundles Electron entry points without bare imports besides Electron and Node built-ins", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "vibecab-electron-bundle-"));
  try {
    const result = await bundleElectron(join(import.meta.dirname, "../src"), outdir);
    const outputs = Object.entries(result.metafile.outputs),
      main = outputs.find(([path]) => path.endsWith("/main.mjs"))?.[1],
      preload = outputs.find(([path]) => path.endsWith("/preload.cjs"))?.[1];
    expect(main).toBeDefined();
    expect(preload).toBeDefined();
    for (const output of [main!, preload!]) {
      for (const imported of output.imports) {
        const bare = !imported.path.startsWith(".") && !imported.path.startsWith("/");
        if (bare) expect(["electron", ...builtinNames]).toContain(imported.path);
      }
    }
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
