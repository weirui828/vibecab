import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stop } from "../../../host/src/control.js";
import { startWebHost } from "../server/web-host.js";
import type { WebHost } from "../server/web-host.js";

export const fakeProvider = resolve(import.meta.dirname, "../dev/fake-provider.json");

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A plain HTTP request where the test controls every header, including Host and Origin. */
export function raw(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { Host: "127.0.0.1:" + port, ...options.headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

export interface TestHost {
  host: WebHost;
  workspace: string;
  cookie: string;
  /** fetch against the web host with the session cookie, like a signed-in browser tab. */
  fetch: typeof fetch;
  close(): Promise<void>;
}

/** A web host on a fresh workspace with a running engine (scripted fake model), signed in once. */
export async function startTestHost(staticRoot?: string): Promise<TestHost> {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-web-test-")),
    host = await startWebHost({ workspace, fakeProvider, ...(staticRoot ? { staticRoot } : {}) });
  await host.engine.start();
  const launch = new URL(host.launchUrl()),
    signIn = await raw(host.port, "GET", launch.pathname + launch.search),
    setCookie = signIn.headers["set-cookie"]?.[0];
  if (!setCookie) throw new Error("Sign-in did not set a cookie");
  const cookie = setCookie.split(";")[0] ?? "";
  const signedFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === "string" ? new URL(input, host.url) : input instanceof URL ? input : new URL(input.url);
    const headers = new Headers(init?.headers);
    headers.set("Cookie", cookie);
    return fetch(url, { ...init, headers });
  };
  return {
    host,
    workspace,
    cookie,
    fetch: signedFetch,
    async close() {
      await host.close();
      await stop(workspace).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
