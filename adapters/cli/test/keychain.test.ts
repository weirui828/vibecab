import { expect, it } from "vitest";
import { readCliToken, saveCliToken } from "../src/keychain.js";

it("stores CLI workspace tokens through the configured key store", async () => {
  await saveCliToken("/workspace/one", "token-one");
  await saveCliToken("/workspace/two", "token-two");

  await expect(readCliToken("/workspace/one")).resolves.toBe("token-one");
  await expect(readCliToken("/workspace/two")).resolves.toBe("token-two");
  await expect(readCliToken("/workspace/missing")).resolves.toBeUndefined();
});

it("contains no direct keyring access", async () => {
  const { readFile } = await import("node:fs/promises"),
    { resolve } = await import("node:path"),
    source = await readFile(resolve(import.meta.dirname, "../src/keychain.ts"), "utf8");

  expect(source).not.toContain("@napi-rs/keyring");
  expect(source).not.toContain("new Entry");
});
