import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { join } from "node:path";
import type { AccessToken, SysCreateAccessTokenOperation } from "../../contract/src/index.js";
import { CONTRACT_VERSION, Contract } from "../../contract/src/index.js";
import { inProcess } from "../../adapters/in-process/src/index.js";
import { fixture } from "../../engine/test/helpers.js";
import type { Engine } from "../../engine/src/engine.js";
import { createServerRecord, ensureToken, serve } from "../src/entry.js";

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
    deletePassword() {
      keychain.delete(this.key);
    }
  },
}));

it("creates a private app-token file, reuses it after restart, and migrates the keychain workspace entry", async () => {
  keychain.clear();
  const f = await fixture(),
    log = vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const created = await inProcess(f.rawEngine).command({
      commandId: "seed-legacy-app-token",
      type: "sys.CreateAccessToken",
      payload: { name: "VibeCab app", channel: "http", scope: "admin" },
    });
    if (!created.ok) throw new Error(created.error.message);
    const legacyToken = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      created.result,
      "#/properties/result",
    ).token;
    keychain.set("VibeCab:app", JSON.stringify({ [f.dir]: legacyToken, "/other/workspace": "other-token" }));
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    const tokenPath = join(f.dir, ".vibecab", "app-token"),
      first = await readFile(tokenPath, "utf8"),
      directoryMode = (await stat(join(f.dir, ".vibecab"))).mode & 0o777,
      fileMode = (await stat(tokenPath)).mode & 0o777;
    expect(first).toBe(legacyToken);
    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    expect(JSON.parse(keychain.get("VibeCab:app") ?? "{}")).toEqual({ "/other/workspace": "other-token" });
    expect((await readdir(join(f.dir, ".vibecab"))).sort()).toEqual(["app-token"]);

    await f.rawEngine.stop();
    await f.rawEngine.start(f.dir);
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    expect(await readFile(tokenPath, "utf8")).toBe(first);

    const tokens = await inProcess(f.rawEngine).query({ name: "sys.AccessTokens", args: {} }),
      listed = new Contract().read<AccessToken[]>("operations/sys.AccessTokens", tokens, "#/properties/result"),
      tokenRecord = listed.find((item) => item.name === "VibeCab app");
    if (!tokenRecord) throw new Error("Host token record was not persisted");
    const revoked = await inProcess(f.rawEngine).command({
      commandId: "revoke-host-app-token",
      type: "sys.RevokeAccessToken",
      payload: { tokenId: tokenRecord.tokenId },
    });
    expect(revoked.ok).toBe(true);
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    const replacement = await readFile(tokenPath, "utf8");
    expect(replacement).not.toBe(first);
    const capability = await f.rawEngine.query(
      { kind: "token", secret: replacement, transport: "http" },
      { contractVersion: CONTRACT_VERSION, requestId: "host-token-test" },
      { name: "sys.Capabilities", args: {} },
    );
    expect(capability).toHaveProperty("callContext.scope", "admin");

    const serverRecord = createServerRecord(
      process.pid,
      "2026-10-30T00:00:00.000Z",
      CONTRACT_VERSION,
      "http://127.0.0.1:1",
      "http://127.0.0.1:2",
      "http://127.0.0.1:3",
    );
    const serverJson = JSON.stringify(serverRecord);
    await writeFile(join(f.dir, ".vibecab", "server.json"), serverJson, { mode: 0o600 });
    expect(serverJson).not.toContain(replacement);
    await f.rawEngine.stop();
    const persistedFiles = await filesUnder(f.dir, tokenPath);
    expect(persistedFiles.map((bytes) => bytes.toString("utf8")).join("\n")).not.toContain(replacement);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(replacement);
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    await f.close();
    keychain.clear();
  }
});

it("secures an overly readable token file and logs only a generic warning", async () => {
  keychain.clear();
  const f = await fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    const tokenPath = join(f.dir, ".vibecab", "app-token"),
      token = await readFile(tokenPath, "utf8");
    await chmod(tokenPath, 0o644);
    await ensureToken(f.rawEngine as Engine, f.dir, "app");
    expect(await readFile(tokenPath, "utf8")).toBe(token);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(token);
    expect(warning).toHaveBeenCalledWith("App token file permissions were too broad; securing the file.");
  } finally {
    warning.mockRestore();
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

async function filesUnder(directory: string, excludePath: string): Promise<Buffer[]> {
  const values = await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (path === excludePath) return [];
      return entry.isDirectory() ? filesUnder(path, excludePath) : [await readFile(path)];
    }),
  );
  return values.flat();
}
