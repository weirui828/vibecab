import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function engineNodePath(packaged: boolean, resourcesPath: string, override: string | undefined): string {
  return packaged ? join(resourcesPath, "engine", "bin", "node") : (override ?? "node");
}

export function hostEntryPath(packaged: boolean, resourcesPath: string, developmentPath: string): string {
  return packaged ? join(resourcesPath, "engine", "bin", "vibecab-host.mjs") : developmentPath;
}

export function mcpRelayPath(packaged: boolean, resourcesPath: string, developmentPath: string): string {
  return packaged ? join(resourcesPath, "engine", "bin", "vibecab-mcp") : developmentPath;
}

export function assertNode26(nodePath: string): void {
  let version = "";
  try {
    version = execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    /* Report below. */
  }
  if (!/^v26\./.test(version)) throw Error("VibeCab requires Node 26. Set VIBECAB_NODE to a Node 26 executable.");
}
