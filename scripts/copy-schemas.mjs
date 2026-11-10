import { cp, mkdir, symlink } from "node:fs/promises";
import { resolve, relative } from "node:path";
await cp("contract/schemas", "dist/contract/schemas", { recursive: true });
await cp("contract/mcp-tools.json", "dist/contract/mcp-tools.json");
await cp("engine/src/agent/prompts", "dist/engine/src/agent/prompts", {
  recursive: true,
});
// pnpm installs dependencies per source package; preserve that resolution in emitted packages.
for (const name of [
  "contract",
  "engine",
  "host",
  "apps/macos",
  "adapters/in-process",
  "adapters/http",
  "adapters/cli",
  "adapters/mcp-server",
  "adapters/mcp-client",
]) {
  const output = resolve("dist", name);
  await mkdir(output, { recursive: true });
  try {
    await symlink(relative(output, resolve(name, "node_modules")), resolve(output, "node_modules"), "dir");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
await mkdir("dist/host/bin", { recursive: true });
await cp("host/bin/vibecab-host.mjs", "dist/host/bin/vibecab-host.mjs");
await mkdir("dist/adapters/mcp-server/bin", { recursive: true });
await cp("adapters/mcp-server/bin/vibecab-mcp.mjs", "dist/adapters/mcp-server/bin/vibecab-mcp.mjs");
