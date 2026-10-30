import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../../../contract/src/index.js";

export async function readAppToken(workspace: string): Promise<string> {
  try {
    const value = await readFile(join(workspace, ".vibecab", "app-token"), "utf8");
    if (value.length > 0 && value.trim() === value) return value;
  } catch {
    // The host creates or repairs this file before reconnect completes.
  }
  fail("unauthenticated", "VibeCab app token is unavailable");
}
