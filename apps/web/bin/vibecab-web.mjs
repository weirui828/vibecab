#!/usr/bin/env node
// Starts the VibeCab web host. Build first (`pnpm build`); development uses `pnpm web:dev`.
import process from "node:process";
import { URL } from "node:url";

const { main } = await import(new URL("../../../dist/apps/web/server/main.js", import.meta.url));
await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
