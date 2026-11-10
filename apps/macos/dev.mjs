#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

// Builds everything, then runs the Mac shell against the built web app (the shell serves it itself).
const build = spawn("pnpm", ["build"], { stdio: "inherit" });
if ((await new Promise((resolve) => build.once("exit", resolve))) !== 0) process.exit(1);
const electron = spawn("pnpm", ["--filter", "@vibecab/macos", "exec", "electron", "."], {
  stdio: "inherit",
  env: { ...process.env, VIBECAB_DEV: "1" },
});
const finish = (code = 0) => {
  electron.kill();
  process.exitCode = code;
};
process.once("SIGINT", () => finish());
process.once("SIGTERM", () => finish());
electron.once("exit", (code) => finish(code ?? 1));
