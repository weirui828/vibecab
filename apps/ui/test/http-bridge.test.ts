import { expect, it } from "vitest";
import { Contract, type CommandResult, type SysCreateAccessTokenOperation } from "../../../contract/src/index.js";
import { inProcess } from "../../../adapters/in-process/src/index.js";
import { httpClient, startHttp } from "../../../adapters/http/src/index.js";
import { fixture } from "../../../engine/test/helpers.js";

it("maps app bridge commands, queries, blobs, and idempotent retries through a live HTTP host", async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    const tokenResult = await inProcess(f.rawEngine).command({
      commandId: "ui-bridge-token",
      type: "sys.CreateAccessToken",
      payload: { name: "UI bridge test", channel: "http", scope: "admin" },
    });
    if (!tokenResult.ok) throw new Error(tokenResult.error.message);
    const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      tokenResult.result,
      "#/properties/result",
    ).token;
    server = await startHttp(f.rawEngine, { transport: "http" });
    const client = httpClient(server.url, token),
      command = { commandId: "ui-bridge-retry", type: "vc.StartSession", payload: { title: "A bridge session" } },
      send = () => client.command(command),
      first: CommandResult = await send(),
      retry: CommandResult = await send();
    expect(retry).toEqual(first);
    const sessions = await client.query({ name: "vc.Sessions", args: {} });
    expect(sessions).toMatchObject([{ title: "A bridge session" }]);
    const bytes = new TextEncoder().encode("bridge blob payload"),
      hash = await client.putBlob(bytes, "text/plain");
    expect(await client.getBlob(hash)).toEqual(bytes);
  } finally {
    await server?.close();
    await f.close();
  }
});
