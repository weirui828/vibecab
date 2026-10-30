import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("does not depend on the OS keychain for the app token", async () => {
  const main = await readFile(resolve(import.meta.dirname, "../src/main.ts"), "utf8"),
    manifest = await readFile(resolve(import.meta.dirname, "../package.json"), "utf8");
  expect(main).not.toContain("@napi-rs/keyring");
  expect(main).not.toContain("keychainToken");
  expect(manifest).not.toContain("@napi-rs/keyring");
});
