import { app } from "electron";
import { join } from "node:path";

export function defaultWorkspace(): string {
  return join(app.getPath("appData"), "VibeCab", "workspaces", "default");
}

export function workspacePath(): string {
  return process.env.VIBECAB_DEV === "1" && process.env.VIBECAB_WORKSPACE_DIR
    ? process.env.VIBECAB_WORKSPACE_DIR
    : defaultWorkspace();
}
