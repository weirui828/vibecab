#!/usr/bin/env node
import process from "node:process";
import { URL } from "node:url";

const host = await import(new URL("../src/entry.js", import.meta.url)).catch(() =>
  import(new URL("../dist/host/src/entry.js", import.meta.url)).catch(
    () => import(new URL("../../dist/host/src/entry.js", import.meta.url)),
  ),
);

const args = process.argv.slice(2),
  workspaceIndex = args.indexOf("--workspace"),
  fakeIndex = args.indexOf("--fake-provider");
if (args[0] === "restore") {
  const archiveIndex = args.indexOf("--archive");
  if (archiveIndex < 0 || !args[archiveIndex + 1] || workspaceIndex < 0 || !args[workspaceIndex + 1]) {
    process.stderr.write("Usage: vibecab-host restore --archive <file> --workspace <empty-directory>\n");
    process.exitCode = 2;
  } else {
    await host.restoreBackup(args[archiveIndex + 1], args[workspaceIndex + 1]);
  }
} else if (args[0] !== "serve" || workspaceIndex < 0 || !args[workspaceIndex + 1]) {
  process.stderr.write(
    "Usage: vibecab-host serve --workspace <directory>\n       vibecab-host restore --archive <file> --workspace <empty-directory>\n",
  );
  process.exitCode = 2;
} else {
  await host.serve(args[workspaceIndex + 1], fakeIndex < 0 ? undefined : args[fakeIndex + 1]);
}
