#!/usr/bin/env node
import { main } from "../../../dist/adapters/cli/src/index.js";
import process from "node:process";

process.exitCode = await main(["tmr", ...process.argv.slice(2)]);
