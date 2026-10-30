import { expect, it } from "vitest";
import { defaults } from "../src/dependencies.js";
import { createKeyStoreFromEnvironment, MemoryKeyStore, NativeKeyStore } from "../src/gateway/keys.js";

it("uses memory storage only when development mode explicitly selects it", () => {
  expect(createKeyStoreFromEnvironment({ VIBECAB_DEV: "1", VIBECAB_KEYSTORE: "memory" })).toBeInstanceOf(
    MemoryKeyStore,
  );
  expect(createKeyStoreFromEnvironment({ VIBECAB_DEV: undefined, VIBECAB_KEYSTORE: "memory" })).toBeInstanceOf(
    NativeKeyStore,
  );
  expect(createKeyStoreFromEnvironment({ VIBECAB_DEV: "0", VIBECAB_KEYSTORE: "memory" })).toBeInstanceOf(
    NativeKeyStore,
  );
});

it("defaults to the test-selected in-memory store", () => {
  expect(defaults().keyStore).toBeInstanceOf(MemoryKeyStore);
});
