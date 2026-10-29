import { it, expect } from "vitest";
import { request } from "node:http";
import { fixture } from "./helpers.js";
import { startHttp } from "../../adapters/http/src/index.js";
import { inProcess } from "../../adapters/in-process/src/index.js";
import { Contract } from "../../contract/src/index.js";
import type { SysCreateAccessTokenOperation } from "../../contract/src/index.js";
function call(url: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve) => {
    const req = request(url + "/v1/capabilities", { headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
    });
    req.end();
  });
}
it("HTTP authenticates all routes, rejects rebinding and foreign origins, and emits no CORS", async () => {
  const f = await fixture();
  const created = await inProcess(f.rawEngine).command({
    commandId: "http-test-token",
    type: "sys.CreateAccessToken",
    payload: { name: "HTTP test", channel: "http", scope: "admin" },
  });
  if (!created.ok) throw Error(created.error.message);
  const token = new Contract().read<SysCreateAccessTokenOperation["result"]>(
    "operations/sys.CreateAccessToken",
    created.result,
    "#/properties/result",
  ).token;
  const server = await startHttp(f.rawEngine, {});
  try {
    for (const [headers, status] of [
      [{}, 401],
      [{ Authorization: "Bearer bad" }, 401],
      [{ Authorization: "Bearer " + token, Host: "evil.test" }, 403],
      [{ Authorization: "Bearer " + token, Origin: "https://evil.test" }, 403],
      [{ Authorization: "Bearer " + token }, 200],
    ] satisfies [Record<string, string>, number][]) {
      const response = await call(server.url, headers);
      expect(response.status).toBe(status);
      expect(Object.keys(response.headers).some((h) => h.startsWith("access-control-"))).toBe(false);
    }
    await expect(startHttp(f.rawEngine, { host: "0.0.0.0" })).rejects.toMatchObject({
      contract: { code: "invalid" },
    });
  } finally {
    await server.close();
    await f.close();
  }
});
