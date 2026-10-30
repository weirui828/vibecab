#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { start, status, serveMcpRelayStdio } from "../../../dist/host/src/index.js";

const secret = process.env.VIBECAB_MCP_TOKEN,
  workspaceValue = process.env.VIBECAB_WORKSPACE;
if (!secret || !workspaceValue) {
  process.stderr.write("VibeCab MCP relay requires VIBECAB_WORKSPACE and VIBECAB_MCP_TOKEN\n");
  process.exitCode = 2;
} else {
  try {
    const workspace = resolve(workspaceValue);
    if (!(await status(workspace)).running) await start(workspace);
    const runtime: unknown = JSON.parse(await readFile(resolve(workspace, ".vibecab", "server.json"), "utf8")),
      mcpUrl = runtime && typeof runtime === "object" ? Reflect.get(runtime, "mcpUrl") : undefined;
    if (typeof mcpUrl !== "string") throw Error("Host did not publish an MCP endpoint");
    await serveMcpRelayStdio(mcpUrl, secret);
  } catch (error) {
    const detail = error instanceof Error ? error.name : "Error";
    process.stderr.write(`VibeCab MCP relay failed: ${detail}\n`);
    process.exitCode = 1;
  }
}
