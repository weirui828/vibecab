#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const build = spawn("pnpm", ["build"], { stdio: "inherit" });
if ((await new Promise((resolve) => build.once("exit", resolve))) !== 0) process.exit(1);
const fuses = spawn("pnpm", ["--filter", "@vibecab/macos", "fuses"], { stdio: "inherit" });
if ((await new Promise((resolve) => fuses.once("exit", resolve))) !== 0) process.exit(1);
const vite = spawn("pnpm", ["--filter", "@vibecab/ui", "dev"], { stdio: "inherit" });
let ready = false;
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const response = await globalThis.fetch("http://127.0.0.1:5173");
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* Vite is starting. */
  }
  await delay(250);
}
if (!ready) {
  vite.kill();
  throw Error("Renderer dev server did not start");
}
const electron = spawn("pnpm", ["--filter", "@vibecab/macos", "exec", "electron", "."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173", VIBECAB_DEV: "1" },
});
const finish = (code = 0) => {
  electron.kill();
  vite.kill();
  process.exitCode = code;
};
process.once("SIGINT", () => finish());
process.once("SIGTERM", () => finish());
electron.once("exit", (code) => finish(code ?? 1));
