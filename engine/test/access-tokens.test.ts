import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Contract } from "../../contract/src/index.js";
import type { SysCreateAccessTokenOperation } from "../../contract/src/index.js";
import { ctx, fixture } from "./helpers.js";
import { createEngine } from "../src/engine.js";
import { clock, ids } from "./helpers.js";

it("creates channel-bound tokens and never returns their secrets again", async () => {
  const f = await fixture();
  try {
    const created = await f.engine.command(ctx, {
      commandId: "token-create-read",
      type: "sys.CreateAccessToken",
      payload: { name: "HTTP read", channel: "http", scope: "read" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      created.result,
      "#/properties/result",
    );
    expect(result.token).toHaveLength(43);
    expect(await f.engine.query(ctx, { name: "sys.AccessTokens", args: {} })).toEqual([result.accessToken]);
    expect(JSON.stringify(await f.engine.query(ctx, { name: "sys.AccessTokens", args: {} }))).not.toContain(
      result.token,
    );
    const events = f.rawEngine.subscribe(
      f.rawEngine.inProcessAuth,
      { contractVersion: "1.0", requestId: "events" },
      { afterSeq: 0 },
    );
    const createdEvent = await events[Symbol.asyncIterator]().next();
    expect(createdEvent.value?.type).toBe("sys.AccessTokenCreated");
    expect(JSON.stringify(createdEvent.value)).not.toContain(result.token);
    const rejected = await f.rawEngine
      .query(
        { kind: "token", secret: result.token, transport: "cli" },
        { contractVersion: "1.0", requestId: "token-wrong-transport" },
        { name: "sys.Capabilities", args: {} },
      )
      .then(
        () => "unexpected success",
        (error: unknown) => JSON.stringify(error),
      );
    expect(rejected).not.toContain(result.token);
    expect(rejected).toContain("unauthenticated");
    expect(
      await f.engine.command(ctx, {
        commandId: "token-create-read",
        type: "sys.CreateAccessToken",
        payload: { name: "HTTP read", channel: "http", scope: "read" },
      }),
    ).toMatchObject({ ok: false, error: { code: "uncertain" } });
    for (const suffix of ["", "-wal"]) {
      const bytes = await readFile(`${f.dir}/workspace.sqlite${suffix}`).catch(() => Buffer.alloc(0));
      expect(bytes.includes(Buffer.from(result.token))).toBe(false);
    }
    await f.engine.stop();
    await f.engine.start(f.dir);
    await expect(
      f.rawEngine.query(
        { kind: "token", secret: result.token, transport: "http" },
        { contractVersion: "1.0", requestId: "token-after-restart" },
        { name: "sys.Capabilities", args: {} },
      ),
    ).resolves.toMatchObject({ contractVersion: "1.0" });
    expect(
      await f.engine.command(ctx, {
        commandId: "token-create-mcp-admin",
        type: "sys.CreateAccessToken",
        payload: { name: "bad", channel: "mcp", scope: "admin" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
  } finally {
    await f.close();
  }
});

it("revokes an access token", async () => {
  const f = await fixture();
  try {
    const created = await f.engine.command(ctx, {
      commandId: "token-create-revoke",
      type: "sys.CreateAccessToken",
      payload: { name: "CLI admin", channel: "cli", scope: "admin" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      created.result,
      "#/properties/result",
    );
    expect(
      await f.engine.command(ctx, {
        commandId: "token-revoke",
        type: "sys.RevokeAccessToken",
        payload: { tokenId: result.accessToken.tokenId },
      }),
    ).toMatchObject({ ok: true, result: { revoked: true } });
    expect(await f.engine.query(ctx, { name: "sys.AccessTokens", args: {} })).toMatchObject([
      { tokenId: result.accessToken.tokenId, revokedAt: expect.any(String) },
    ]);
  } finally {
    await f.close();
  }
});

it("resolves scope and channel from the stored token, rejects forged context fields, and applies revocation immediately", async () => {
  const f = await fixture();
  try {
    const created = await f.rawEngine.command(
      f.rawEngine.inProcessAuth,
      {
        contractVersion: "1.0",
        requestId: "create-auth-test-token",
      },
      {
        commandId: "create-auth-test-token-command",
        type: "sys.CreateAccessToken",
        payload: { name: "read only", channel: "http", scope: "read" },
      },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      created.result,
      "#/properties/result",
    );
    const credential = { kind: "token" as const, secret: token.token, transport: "http" as const },
      metadata = { contractVersion: "1.0", requestId: "auth-call" };
    await expect(
      f.rawEngine.query(credential, metadata, { name: "sys.Capabilities", args: {} }),
    ).resolves.toMatchObject({
      contractVersion: "1.0",
    });
    await expect(
      f.rawEngine.command(credential, metadata, {
        commandId: "read-token-admin-operation",
        type: "sys.SetSettings",
        payload: { patch: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    await expect(
      f.rawEngine.query({ ...credential, transport: "cli" }, metadata, { name: "sys.Capabilities", args: {} }),
    ).rejects.toMatchObject({ contract: { code: "unauthenticated" } });
    let wrongChannelError: unknown;
    try {
      await f.rawEngine.query({ ...credential, transport: "cli" }, metadata, { name: "sys.Capabilities", args: {} });
    } catch (error) {
      wrongChannelError = error;
    }
    expect(JSON.stringify(wrongChannelError)).not.toContain(token.token);

    const forgedContext = { kind: "trusted_host", scope: "admin" },
      forgedToken = { ...credential, scope: "admin", channel: "in_process" };
    await expect(
      Reflect.apply(f.rawEngine.query, f.rawEngine, [forgedContext, metadata, { name: "sys.Capabilities", args: {} }]),
    ).rejects.toMatchObject({ contract: { code: "unauthenticated" } });
    await expect(
      Reflect.apply(f.rawEngine.command, f.rawEngine, [
        forgedToken,
        metadata,
        {
          commandId: "forged-scope-command",
          type: "sys.SetSettings",
          payload: { patch: {} },
        },
      ]),
    ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });

    const revoke = await f.rawEngine.command(f.rawEngine.inProcessAuth, metadata, {
      commandId: "revoke-auth-test-token",
      type: "sys.RevokeAccessToken",
      payload: { tokenId: token.accessToken.tokenId },
    });
    expect(revoke.ok).toBe(true);
    await expect(f.rawEngine.query(credential, metadata, { name: "sys.Capabilities", args: {} })).rejects.toMatchObject(
      {
        contract: { code: "unauthenticated" },
      },
    );
  } finally {
    await f.close();
  }
});

it("limits repeated invalid token attempts per transport", async () => {
  const f = await fixture();
  try {
    const auth = { kind: "token" as const, secret: "invalid-secret", transport: "http" as const };
    for (let index = 0; index < 10; index++)
      await expect(
        f.rawEngine.query(
          auth,
          { contractVersion: "1.0", requestId: `bad-${index}` },
          { name: "sys.Capabilities", args: {} },
        ),
      ).rejects.toMatchObject({ contract: { code: "unauthenticated" } });
    await expect(
      f.rawEngine.query(auth, { contractVersion: "1.0", requestId: "bad-11" }, { name: "sys.Capabilities", args: {} }),
    ).rejects.toMatchObject({ contract: { code: "rate_limited" } });
  } finally {
    await f.close();
  }
});

it("rejects every admin operation on the MCP channel", async () => {
  const f = await fixture();
  try {
    const created = await f.rawEngine.command(
      f.rawEngine.inProcessAuth,
      {
        contractVersion: "1.0",
        requestId: "create-mcp-collaborator",
      },
      {
        commandId: "create-mcp-collaborator",
        type: "sys.CreateAccessToken",
        payload: { name: "MCP collaborator", channel: "mcp", scope: "collaborate" },
      },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
        "operations/sys.CreateAccessToken",
        created.result,
        "#/properties/result",
      ).token,
      auth = { kind: "token" as const, secret: token, transport: "mcp" as const },
      metadata = { contractVersion: "1.0", requestId: "mcp-admin-check" };
    for (const [name, operation] of new Contract().operations) {
      if (operation.meta.effect !== "admin") continue;
      if (operation.kind === "command")
        expect(
          await f.rawEngine.command(auth, metadata, { commandId: `admin-${name}`, type: name, payload: {} }),
          name,
        ).toMatchObject({ ok: false, error: { code: "forbidden" } });
      else
        await expect(f.rawEngine.query(auth, metadata, { name, args: {} })).rejects.toMatchObject({
          contract: { code: "forbidden" },
        });
    }
  } finally {
    await f.close();
  }
});

it("migrates the legacy token file into a hashed HTTP admin token and deletes the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibecab-token-migration-")),
    secret = "legacy-admin-secret-0123456789abcdef",
    engine = createEngine({ clock, ids: ids(), seed: 42, modelProviders: {} });
  try {
    await writeFile(
      join(dir, "access-tokens.json"),
      JSON.stringify({
        read: "legacy-read-secret-0123456789abcd",
        collaborate: "legacy-collab-secret-0123456789",
        admin: secret,
      }),
      { mode: 0o600 },
    );
    await engine.start(dir);
    await expect(readFile(join(dir, "access-tokens.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      engine.query(
        { kind: "token", secret, transport: "http" },
        { contractVersion: "1.0", requestId: "legacy-token-call" },
        { name: "sys.Capabilities", args: {} },
      ),
    ).resolves.toMatchObject({ contractVersion: "1.0" });
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
