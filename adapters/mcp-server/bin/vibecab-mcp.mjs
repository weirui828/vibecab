#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

let host;
for (const candidate of ["../../../dist/host/src/index.js", "../../../host/src/index.js"]) {
  try {
    host = await import(new URL(candidate, import.meta.url));
    break;
  } catch {
    // The package bin and workspace bin have different relative build roots.
  }
}
if (!host) throw new Error("VibeCab host runtime is unavailable");
const { start, status, serveMcpRelayStdio } = host;

const secret = process.env.VIBECAB_MCP_TOKEN,
  workspaceValue = process.env.VIBECAB_WORKSPACE;
if (!secret || !workspaceValue) {
  process.stderr.write("VibeCab MCP relay requires VIBECAB_WORKSPACE and VIBECAB_MCP_TOKEN\n");
  process.exitCode = 2;
} else {
  try {
    const workspace = resolve(workspaceValue);
    const hostOptions =
      process.env.VIBECAB_DEV === "1" && process.env.VIBECAB_HOST_ENTRY
        ? { hostEntry: process.env.VIBECAB_HOST_ENTRY }
        : {};
    if (!(await status(workspace)).running) await start(workspace, hostOptions);
    const runtime = JSON.parse(await readFile(resolve(workspace, ".vibecab", "server.json"), "utf8")),
      mcpUrl = runtime && typeof runtime === "object" ? Reflect.get(runtime, "mcpUrl") : undefined;
    if (typeof mcpUrl !== "string") throw Error("Host did not publish an MCP endpoint");
    await serveMcpRelayStdio(mcpUrl, secret);
  } catch (error) {
    const detail = error instanceof Error ? error.name : "Error";
    process.stderr.write(`VibeCab MCP relay failed: ${detail}\n`);
    process.exitCode = 1;
  }
}
