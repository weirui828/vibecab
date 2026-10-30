import { readdir, readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { CONTRACT_VERSION, Contract } from "../../contract/src/index.js";
import { inProcess } from "../../adapters/in-process/src/index.js";
import { fixture } from "../../engine/test/helpers.js";
import type { Engine } from "../../engine/src/engine.js";
import { ensureToken, serve } from "../src/entry.js";

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    private readonly key: string;
    constructor(service: string, account: string) {
      this.key = service + ":" + account;
    }
    getPassword() {
      return keychain.get(this.key) ?? null;
    }
    setPassword(value: string) {
      keychain.set(this.key, value);
    }
  },
}));

it("creates, reuses, and replaces a revoked host token without persisting its secret", async () => {
  keychain.clear();
  const f = await fixture();
  try {
    const tokenMap = () => JSON.parse(keychain.get("VibeCab:app") ?? "{}") as Record<string, string>;
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    const first = tokenMap()[f.dir];
    expect(first).toEqual(expect.any(String));
    if (!first) throw new Error("Host app token was not stored");
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    expect(tokenMap()[f.dir]).toBe(first);

    const tokens = await inProcess(f.rawEngine).query({ name: "sys.AccessTokens", args: {} }),
      listed = new Contract().read<Array<{ tokenId: string }>>(
        "operations/sys.AccessTokens",
        tokens,
        "#/properties/result",
      ),
      tokenRecord = listed.find((item) => item.tokenId);
    if (!tokenRecord) throw new Error("Host token record was not persisted");
    const revoked = await inProcess(f.rawEngine).command({
      commandId: "revoke-host-app-token",
      type: "sys.RevokeAccessToken",
      payload: { tokenId: tokenRecord.tokenId },
    });
    expect(revoked.ok).toBe(true);
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    const replacement = tokenMap()[f.dir];
    expect(replacement).not.toBe(first);
    if (!replacement) throw new Error("Replacement host app token was not stored");

    const files = await filesUnder(f.dir);
    expect(files.some((bytes) => bytes.includes(Buffer.from(replacement)))).toBe(false);
    const capability = await f.rawEngine.query(
      { kind: "token", secret: replacement, transport: "http" },
      { contractVersion: CONTRACT_VERSION, requestId: "host-token-test" },
      { name: "sys.Capabilities", args: {} },
    );
    expect(capability).toHaveProperty("callContext.scope", "admin");
  } finally {
    await f.close();
    keychain.clear();
  }
});

it("refuses fake-provider mode without the development opt-in", async () => {
  const previous = process.env.VIBECAB_DEV;
  delete process.env.VIBECAB_DEV;
  try {
    await expect(serve("/tmp/vibecab-fake-gate", "/tmp/fake-provider.json")).rejects.toThrow(
      "--fake-provider requires VIBECAB_DEV=1",
    );
  } finally {
    if (previous === undefined) delete process.env.VIBECAB_DEV;
    else process.env.VIBECAB_DEV = previous;
  }
});

async function filesUnder(directory: string): Promise<Buffer[]> {
  const values = await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(path) : [await readFile(path)];
    }),
  );
  return values.flat();
}
