/* global process, URL, Buffer */
// Design preview: runs a real engine host (scripted fake model) and serves the built renderer in a browser.
// Usage: VIBECAB_DEV=1 VIBECAB_KEYSTORE=memory node apps/ui/preview/server.mjs <workspace> <fake-provider.json> [port]
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { start } from "../../../dist/host/src/index.js";

const [workspaceArg, scriptArg, portArg] = process.argv.slice(2);
if (!workspaceArg || !scriptArg) throw new Error("Usage: server.mjs <workspace> <fake-provider.json> [port]");
if (process.env.VIBECAB_DEV !== "1") throw new Error("The preview server needs VIBECAB_DEV=1");
const workspace = resolve(workspaceArg),
  root = resolve(import.meta.dirname, "../../../dist/apps/ui"),
  shim = resolve(import.meta.dirname, "shim.js");
const runtime = await start(workspace, { fakeProvider: resolve(scriptArg) });
const api = new URL(runtime.httpUrl),
  token = (await readFile(join(workspace, ".vibecab", "app-token"), "utf8")).trim();
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://preview");
  if (url.pathname.startsWith("/v1/")) {
    const headers = { ...req.headers, host: api.host, authorization: "Bearer " + token };
    delete headers.origin;
    delete headers.referer;
    const upstream = httpRequest(
      { host: api.hostname, port: api.port, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
    return;
  }
  if (url.pathname === "/preview-shim.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(shim));
    return;
  }
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    let body = await readFile(join(root, path));
    if (path === "/index.html")
      body = Buffer.from(body.toString().replace("<head>", '<head><script src="/preview-shim.js"></script>'));
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(portArg ?? 5199), "127.0.0.1", () => {
  process.stdout.write(`PREVIEW_READY http://127.0.0.1:${portArg ?? 5199}\n`);
});
