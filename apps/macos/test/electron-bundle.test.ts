import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { bundleElectron } from "../scripts/bundle-electron.mjs";

const builtinNames = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

it("bundles the shell's main entry, and no preload, without bare imports besides Electron and Node built-ins", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "vibecab-electron-bundle-"));
  try {
    const result = await bundleElectron(join(import.meta.dirname, "../src"), outdir);
    const outputs = Object.entries(result.metafile.outputs),
      main = outputs.find(([path]) => path.endsWith("/main.mjs"))?.[1];
    expect(main).toBeDefined();
    expect(outputs.some(([path]) => /preload/.test(path))).toBe(false);
    // The web host runs inside main, so its code is part of the bundle.
    expect(Object.keys(result.metafile.inputs).some((path) => path.endsWith("web/server/web-host.ts"))).toBe(true);
    for (const output of [main!]) {
      for (const imported of output.imports) {
        const bare = !imported.path.startsWith(".") && !imported.path.startsWith("/");
        if (bare) expect(["electron", ...builtinNames]).toContain(imported.path);
      }
    }
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});

it("runs a bundled Contract from outside the repository without schema files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibecab-contract-bundle-")),
    output = join(directory, "contract.mjs"),
    source = join(import.meta.dirname, "../../../contract/src/index.ts");
  try {
    await build({
      entryPoints: [source],
      outfile: output,
      bundle: true,
      platform: "node",
      target: "node26",
      format: "esm",
      external: builtinModules.flatMap((name) => [name, `node:${name}`]),
    });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { Contract } = await import(${JSON.stringify(pathToFileURL(output).href)});
const contract = new Contract();
contract.read("element", { elementId: "el_00000000000000000000000001", type: "paragraph", parentId: null, order: "a0", props: {}, text: "Hello." });`,
      ],
      { cwd: directory, stdio: "pipe" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
