import { createHash } from "node:crypto";
import { cp, link, lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export async function prepareEngineNodeModules(root) {
  const virtualRoot = join(root, ".pnpm/node_modules");
  const visitedDependencies = new Set();
  async function exposeDependencies(packageDirectory) {
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...optional])) {
      if (visitedDependencies.has(name)) continue;
      visitedDependencies.add(name);
      const dependency = join(virtualRoot, name);
      const exposed = join(root, name);
      try {
        await readFile(join(exposed, "package.json"));
      } catch {
        try {
          await cp(dependency, exposed, { recursive: true, dereference: true, errorOnExist: true });
        } catch (error) {
          if (!optional.has(name) || error?.code !== "ENOENT") throw error;
          continue;
        }
      }
      await exposeDependencies(exposed);
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".pnpm") continue;
    const path = join(root, entry.name);
    const children = entry.name.startsWith("@") ? await readdir(path, { withFileTypes: true }) : [entry];
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const packageDirectory = entry.name.startsWith("@") ? join(path, child.name) : path;
      if (await readFile(join(packageDirectory, "package.json"), "utf8").catch(() => undefined))
        await exposeDependencies(packageDirectory);
    }
  }

  async function prune(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["docs", "test", "tests", "example", "examples"].includes(entry.name)) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (entry.name === "src" && (await stat(join(directory, "dist")).catch(() => undefined))) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (entry.name === "better-sqlite3") await pruneSqlite(path);
        await prune(path);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts") || entry.name.endsWith(".md")) {
          await rm(path, { force: true });
        }
      }
    }
  }
  async function pruneSqlite(packageDirectory) {
    await Promise.all(
      ["deps", "src", "README.md", "binding.gyp"].map((item) =>
        rm(join(packageDirectory, item), { recursive: true, force: true }),
      ),
    );
    const prebuilds = join(packageDirectory, "prebuilds");
    for (const entry of await readdir(prebuilds).catch(() => []))
      if (entry !== "darwin-arm64.node") await rm(join(prebuilds, entry), { recursive: true, force: true });
    const release = join(packageDirectory, "build/Release");
    for (const entry of await readdir(release, { withFileTypes: true }).catch(() => []))
      if (!entry.isFile() || !entry.name.endsWith(".node"))
        await rm(join(release, entry.name), { recursive: true, force: true });
  }
  await prune(root);

  const seen = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (
          ![".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".html", ".css", ".yaml", ".yml"].includes(
            extname(entry.name),
          )
        )
          continue;
        const info = await lstat(path),
          content = await readFile(path);
        const hash = createHash("sha256").update(content).digest("hex"),
          key = `${info.size}:${hash}`;
        const original = seen.get(key);
        if (!original) seen.set(key, path);
        else {
          await rm(path);
          await link(original, path);
        }
      }
    }
  }
  await visit(root);
  await rm(join(root, ".pnpm"), { recursive: true, force: true });
}
