#!/usr/bin/env node
import process from "node:process";
import { URL } from "node:url";

const { serve } = await import(new URL("../src/entry.js", import.meta.url)).catch(
  () => import(new URL("../../dist/host/src/entry.js", import.meta.url)),
);

const args = process.argv.slice(2),
  workspaceIndex = args.indexOf("--workspace"),
  fakeIndex = args.indexOf("--fake-provider");
if (args[0] !== "serve" || workspaceIndex < 0 || !args[workspaceIndex + 1]) {
  process.stderr.write("Usage: vibecab-host serve --workspace <directory>\n");
  process.exitCode = 2;
} else {
  await serve(args[workspaceIndex + 1], fakeIndex < 0 ? undefined : args[fakeIndex + 1]);
}
