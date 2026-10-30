import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

function binaries(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? binaries(path)
      : entry.isFile() && entry.name.endsWith(".mjs") && directory.split("/").includes("bin")
        ? [path]
        : [];
  });
}

it("keeps every bin entry point valid JavaScript", () => {
  const files = [
    ...readdirSync("adapters", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => binaries(join("adapters", entry.name))),
    ...binaries("host/bin"),
  ];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(() => execFileSync(process.execPath, ["--check", resolve(file)])).not.toThrow();
});
