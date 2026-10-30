import { Entry } from "@napi-rs/keyring";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const service = "VibeCab";

export function readCliToken(workspaceDir: string): string | undefined {
  try {
    const value = new Entry(service, "cli").getPassword();
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        const token = Reflect.get(parsed, workspaceDir);
        return typeof token === "string" ? token : undefined;
      }
    } catch {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveCliToken(workspaceDir: string, token: string): void {
  const entry = new Entry(service, "cli"),
    current = entry.getPassword();
  let tokens: Record<string, string> = {};
  if (current) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        tokens = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string"));
    } catch {
      tokens = {};
    }
  }
  tokens[workspaceDir] = token;
  entry.setPassword(JSON.stringify(tokens));
}

export async function readSecret(prompt: string): Promise<string> {
  stdout.write(prompt);
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      return await terminal.question("");
    } finally {
      terminal.close();
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const onData = (value: Buffer) => {
      for (const character of value.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(Error("Input cancelled"));
        } else if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(chunks.join(""));
        } else if (character === "\u007f" || character === "\b") chunks.pop();
        else chunks.push(character);
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
