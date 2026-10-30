#!/usr/bin/env node
import process from "node:process";
import { main } from "../dist/adapters/cli/src/index.js";
process.exitCode = await main(process.argv.slice(2));
