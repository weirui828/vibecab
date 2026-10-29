import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import type { Engine } from "../../../engine/src/engine.js";
import { createMcpServer } from "./index.js";

export function serveMcpStdio(engine: Engine, secret: string, transport?: Transport) {
  return serveStdio(() => createMcpServer(engine, secret), {
    ...(transport ? { transport } : {}),
    onerror: (error) => process.stderr.write(`VibeCab MCP transport error: ${error.name}\n`),
  });
}
