import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stop } from "../../../host/src/control.js";
import { startWebHost } from "../server/web-host.js";
import type { WebHost, WebHostOptions } from "../server/web-host.js";

export const fakeProvider = resolve(import.meta.dirname, "../dev/fake-provider.json");

/** Addresses the web host asked for (model lists): tests never reach the network. */
export const fetched: string[] = [];
/** Stands in for the network: OpenRouter's model list and a local Ollama with one model; anything else fails. */
export const fakeNetwork: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  const body =
    url === "https://openrouter.ai/api/v1/models"
      ? {
          data: [
            {
              id: "acme/swift-1",
              name: "Acme: Swift 1",
              context_length: 200000,
              pricing: { prompt: "0.0000005", completion: "0.0000015" },
            },
            { id: 42 },
          ],
        }
      : url === "http://localhost:11434/v1/models"
        ? { data: [{ id: "llama-local:8b", object: "model" }] }
        : undefined;
  return body ? Response.json(body) : new Response("no", { status: 503 });
};

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
export async function startTestHost(staticRoot?: string, extra: Partial<WebHostOptions> = {}): Promise<TestHost> {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-web-test-")),
    host = await startWebHost({
      workspace,
      fakeProvider,
      fetch: fakeNetwork,
      ...extra,
      ...(staticRoot ? { staticRoot } : {}),
    });
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
