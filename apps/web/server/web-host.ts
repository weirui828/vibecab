import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { jsonBody, ownFetch, sameHost, sameOrigin } from "./access.js";
import { providerCatalog, readLiveModels } from "../../../contract/src/provider-catalog.js";
import { EngineLink } from "./engine.js";

export interface WebHostOptions {
  workspace: string;
  port?: number;
  /** Built renderer directory. Ignored when `middleware` is given. */
  staticRoot?: string;
  /** Development: a Connect-style handler (Vite in middleware mode) for everything that is not /v1 or /app. */
  middleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  fakeProvider?: string;
  /** The Node and host entry that run the engine, when they are not this process's own (the packaged Mac app). */
  engineHost?: { nodePath: string; hostEntry: string };
  version?: string;
  /** Path of the MCP stdio relay for assistant setup; found in the repository when not given. */
  mcpRelayPath?: string;
  /** For model lists from providers (tests pass a fake; nothing else here reaches the network). */
  fetch?: typeof fetch;
}

export interface WebHost {
  url: string;
  port: number;
  engine: EngineLink;
  close(): Promise<void>;
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
const csp =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const forwardedHeaders = ["content-type", "accept", "last-event-id", "x-contract-version"];

function error(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ code, message, retryable: code === "unavailable" }));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = part as Buffer;
    size += chunk.length;
    if (size > 17 * 1024 * 1024) throw new Error("too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startWebHost(options: WebHostOptions): Promise<WebHost> {
  const engine = new EngineLink(options.workspace, {
    ...(options.fakeProvider ? { fakeProvider: options.fakeProvider } : {}),
    ...(options.engineHost ? { host: options.engineHost } : {}),
  });
  let port = 0;
  const relayPath = () => {
    if (options.mcpRelayPath) return options.mcpRelayPath;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "adapters", "mcp-server", "bin", "vibecab-mcp.mjs");
      if (existsSync(candidate)) return candidate;
      dir = dirname(dir);
    }
    return undefined;
  };
  const sockets = new Set<ServerResponse>();

  async function forward(req: IncomingMessage, res: ServerResponse, retried = false, body?: Buffer): Promise<void> {
    const target = await engine.target();
    if (!target) return error(res, 503, "unavailable", "The engine is not running");
    const payload = body ?? (req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req));
    const headers: Record<string, string> = { Host: target.url.host, Authorization: "Bearer " + target.token };
    for (const name of forwardedHeaders) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (payload.length > 0) headers["content-length"] = String(payload.length);
    const upstream = httpRequest(
      { host: target.url.hostname, port: target.url.port, path: req.url, method: req.method, headers },
      (up) => {
        // The token can change when the host restarts; read it again once.
        if (up.statusCode === 401 && !retried) {
          up.resume();
          engine.invalidate();
          void forward(req, res, true, payload).catch(() => error(res, 502, "unavailable", "The engine stopped"));
          return;
        }
        const out: Record<string, string> = {};
        for (const name of ["content-type", "cache-control", "connection"]) {
          const value = up.headers[name];
          if (typeof value === "string") out[name] = value;
        }
        res.writeHead(up.statusCode ?? 502, out);
        if (out["content-type"]?.startsWith("text/event-stream")) res.flushHeaders();
        up.pipe(res);
      },
    );
    res.on("close", () => upstream.destroy());
    upstream.on("error", () => {
      engine.invalidate();
      error(res, 503, "unavailable", "The engine is unreachable");
    });
    upstream.end(payload);
  }

  // A provider's live model list. Only addresses written in the built-in catalog are fetched — never one the page
  // sends — and no key is sent: OpenRouter's list is public and local servers need none.
  async function providerModels(providerId: string) {
    const live = providerCatalog.providers.find((p) => p.id === providerId)?.liveModels;
    if (!live) return { models: [], error: "no_list" };
    try {
      const res = await (options.fetch ?? fetch)(live.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { models: [], error: "unreachable" };
      return { models: readLiveModels(live.format, await res.json()) };
    } catch {
      return { models: [], error: "unreachable" };
    }
  }

  async function app(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const json = (value: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && path === "/app/state")
      return json({
        connection: await engine.state(),
        version: options.version ?? "0.1.0",
        engine: (await engine.info().catch(() => undefined)) ?? null,
        workspacePath: options.workspace,
        mcpRelayPath: relayPath(),
      });
    if (req.method === "GET" && path === "/app/provider-models")
      return json(await providerModels(url.searchParams.get("provider") ?? ""));
    if (req.method === "POST" && path === "/app/restart-engine") {
      try {
        return json({ connection: await engine.restart() });
      } catch {
        return json({ connection: "Engine unreachable" });
      }
    }
    if (req.method === "POST" && path === "/app/start-engine") {
      try {
        return json({ connection: await engine.start() });
      } catch {
        return json({ connection: "Engine unreachable" });
      }
    }
    error(res, 404, "not_found", "Unknown app endpoint");
  }

  async function serveStatic(res: ServerResponse, path: string) {
    const root = resolve(options.staticRoot ?? "."),
      file = normalize(join(root, path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + sep)) return error(res, 404, "not_found", "Not found");
    try {
      const bytes = await readFile(file),
        type = types[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": file.includes(sep + "assets" + sep) ? "public, max-age=31536000, immutable" : "no-cache",
        ...(type.startsWith("text/html") ? { "Content-Security-Policy": csp } : {}),
      });
      res.end(bytes);
    } catch {
      error(res, 404, "not_found", "Not found");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!sameHost(req, port)) return error(res, 403, "forbidden", "Invalid Host");
    if (!sameOrigin(req, port)) return error(res, 403, "forbidden", "Origin is not permitted");
    const url = new URL(req.url ?? "/", "http://127.0.0.1:" + port),
      path = url.pathname;
    // One address: a browser keeps preferences (theme, where threads show) per site, and localhost is another
    // site to it. Page loads opened on localhost (SkyEye's Open, a typed address) move over; API calls stay.
    const page = !path.startsWith("/v1/") && !path.startsWith("/app/");
    if ((req.method === "GET" || req.method === "HEAD") && page && req.headers.host === "localhost:" + port) {
      res.writeHead(307, { Location: "http://127.0.0.1:" + port + path + url.search, "Cache-Control": "no-store" });
      return res.end();
    }
    // Sign-in links from before there was no sign-in still open VibeCab.
    if (req.method === "GET" && path === "/" && url.searchParams.has("launch")) {
      res.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }
    // No browser sign-in: the Host check (DNS rebinding) and the Origin check (CSRF) above keep websites out, with
    // the browser's own word on where a call comes from, and JSON-only commands, as a second wall.
    if (path.startsWith("/v1/") || path.startsWith("/app/")) {
      if (!ownFetch(req)) return error(res, 403, "forbidden", "Only VibeCab's own pages can call it");
      if (req.method === "POST" && /^\/v1\/(commands|queries)\//.test(path) && !jsonBody(req))
        return error(res, 415, "invalid", "Commands and queries must be JSON");
      if (path.startsWith("/app/")) return app(req, res, path, url);
      sockets.add(res);
      res.on("close", () => sockets.delete(res));
      return forward(req, res);
    }
    if (options.middleware) return options.middleware(req, res, () => error(res, 404, "not_found", "Not found"));
    if (req.method !== "GET" && req.method !== "HEAD") return error(res, 405, "invalid", "Method not allowed");
    return serveStatic(res, path);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => error(res, 500, "internal", "Something went wrong"));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  const url = "http://127.0.0.1:" + port;
  // `vibecab-web link` finds this host's address here.
  const runtimeFile = join(options.workspace, ".vibecab", "web.json");
  await mkdir(dirname(runtimeFile), { recursive: true, mode: 0o700 });
  await writeFile(runtimeFile, JSON.stringify({ url, pid: process.pid }), { mode: 0o600 });
  return {
    url,
    port,
    engine,
    close: async () => {
      await rm(runtimeFile, { force: true });
      for (const res of sockets) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
