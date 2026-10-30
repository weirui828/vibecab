import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareEngineNodeModules } from "../scripts/prepare-engine-node-modules.mjs";

it("keeps only arm64 SQLite runtime files and hardlinks duplicate package assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecab-engine-modules-"));
  const sqlite = join(root, "node_modules/better-sqlite3");
  const prebuilds = join(sqlite, "prebuilds");
  const openai = join(root, "node_modules/openai");
  await mkdir(prebuilds, { recursive: true });
  await mkdir(join(sqlite, "src"), { recursive: true });
  await mkdir(join(sqlite, "lib"), { recursive: true });
  await mkdir(join(openai, "src"), { recursive: true });
  await writeFile(join(prebuilds, "darwin-arm64.node"), "native");
  await writeFile(join(prebuilds, "win32-x64.node"), "other platform");
  await writeFile(join(sqlite, "src/source.cc"), "compile time only");
  await writeFile(join(sqlite, "lib/index.js"), "runtime");
  await writeFile(join(openai, "src/index.ts"), "compile time only");
  await writeFile(join(openai, "client.js"), "same package asset");
  await writeFile(join(root, "node_modules/openai/client-copy.js"), "same package asset");

  try {
    await prepareEngineNodeModules(join(root, "node_modules"));

    expect(await readFile(join(prebuilds, "darwin-arm64.node"), "utf8")).toBe("native");
    await expect(readFile(join(prebuilds, "win32-x64.node"))).rejects.toThrow();
    await expect(readFile(join(sqlite, "src/source.cc"))).rejects.toThrow();
    await expect(readFile(join(openai, "src/index.ts"))).rejects.toThrow();
    expect((await stat(join(openai, "client.js"))).ino).toBe(
      (await stat(join(root, "node_modules/openai/client-copy.js"))).ino,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("exposes the contract workspace package runtime dependency closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecab-engine-contract-deps-"));
  const contract = join(root, "node_modules/@vibecab/contract");
  const virtual = join(root, "node_modules/.pnpm/node_modules");
  await mkdir(contract, { recursive: true });
  await mkdir(join(virtual, "ajv/lib"), { recursive: true });
  await mkdir(join(virtual, "fast-uri/lib"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@vibecab/contract": "*" } }));
  await writeFile(join(contract, "package.json"), JSON.stringify({ dependencies: { ajv: "*" } }));
  await writeFile(join(virtual, "ajv/package.json"), JSON.stringify({ dependencies: { "fast-uri": "*" } }));
  await writeFile(join(virtual, "ajv/lib/index.js"), "ajv runtime");
  await writeFile(join(virtual, "fast-uri/package.json"), JSON.stringify({ dependencies: {} }));
  await writeFile(join(virtual, "fast-uri/lib/index.js"), "uri runtime");

  try {
    await prepareEngineNodeModules(join(root, "node_modules"));

    expect(await readFile(join(root, "node_modules/ajv/lib/index.js"), "utf8")).toBe("ajv runtime");
    expect(await readFile(join(root, "node_modules/fast-uri/lib/index.js"), "utf8")).toBe("uri runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
