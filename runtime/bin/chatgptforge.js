#!/usr/bin/env node
import { runEntrypoint } from "./run-entrypoint.js";
await runEntrypoint("../src/forge-cli.ts", "../dist/forge-cli.js");
