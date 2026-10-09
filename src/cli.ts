#!/usr/bin/env node
import { Bridge } from "./bridge.js";
import { ConfigError, USAGE, parseConfig } from "./config.js";
import { runStdio } from "./stdio.js";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(0);
}

try {
  const config = parseConfig(argv, process.env);
  const log = (message: string) => process.stderr.write(`tripezgo-mcp: ${message}\n`);
  log(`bridging stdio to ${config.baseUrl}/mcp`);
  await runStdio(process.stdin, process.stdout, new Bridge({ ...config, log }));
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`tripezgo-mcp: ${error.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  throw error;
}
