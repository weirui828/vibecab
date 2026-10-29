import { contractSuite } from "./suite.js";
import { fixture } from "../helpers.js";
import { inProcess } from "../../../adapters/in-process/src/index.js";
import { startHttp, httpClient } from "../../../adapters/http/src/index.js";
import { cliAdapter } from "../../../adapters/cli/src/adapter.js";
import { Contract } from "../../../contract/src/index.js";
import type { SysCreateAccessTokenOperation } from "../../../contract/src/index.js";
contractSuite("in-process", async () => {
  const f = await fixture();
  const adapter = inProcess(f.rawEngine);
  const client: import("./suite.js").Client = {
    command: (cmd) => adapter.command(cmd),
    query: (q) => adapter.query(q),
    subscribe: (sub) => adapter.subscribe(sub),
    putBlob: (bytes, type) => adapter.putBlob(bytes, type),
    getBlob: (hash) => adapter.getBlob(hash),
  };
  return { client, close: f.close };
});
contractSuite("HTTP", async () => {
  const f = await fixture();
  const tokenResult = await inProcess(f.rawEngine).command({
    commandId: "contract-http-token",
    type: "sys.CreateAccessToken",
    payload: { name: "contract suite", channel: "http", scope: "admin" },
  });
  if (!tokenResult.ok) throw Error(tokenResult.error.message);
  const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
    "operations/sys.CreateAccessToken",
    tokenResult.result,
    "#/properties/result",
  ).token;
  const server = await startHttp(f.rawEngine, {});
  return {
    client: httpClient(server.url, token),
    close: async () => {
      await server.close();
      await f.close();
    },
  };
});
contractSuite("CLI", async () => {
  const f = await fixture();
  const tokenResult = await inProcess(f.rawEngine).command({
    commandId: "contract-cli-token",
    type: "sys.CreateAccessToken",
    payload: { name: "contract suite", channel: "cli", scope: "admin" },
  });
  if (!tokenResult.ok) throw Error(tokenResult.error.message);
  const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
    "operations/sys.CreateAccessToken",
    tokenResult.result,
    "#/properties/result",
  ).token;
  return { client: cliAdapter(f.rawEngine, token), close: f.close };
});
