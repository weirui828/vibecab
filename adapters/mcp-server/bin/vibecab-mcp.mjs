#!/usr/bin/env node
import process from "node:process";
import { createEngine } from "../../../dist/engine/src/engine.js";
import { serveMcpStdio } from "../../../dist/adapters/mcp-server/src/stdio.js";

const secret = process.env.VIBECAB_MCP_TOKEN,
  workspace = process.env.VIBECAB_WORKSPACE;
if (!secret) throw new Error("VIBECAB_MCP_TOKEN is required");
if (!workspace) throw new Error("VIBECAB_WORKSPACE is required");
const engine = createEngine();
await engine.start(workspace);
const server = serveMcpStdio(engine, secret);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
  await engine.stop();
}
process.stdin.once("end", () => void stop());
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
