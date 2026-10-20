#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.js";
import { ConfigError, USAGE, parseConfig } from "./config.js";
import { loadGuide } from "./guide.js";
import { runCommand, runInstall, stableNodePath } from "./install.js";
import { SKILL_PATH, loadAppToolSnapshot, packageRootOf, packageVersion } from "./package.js";
import { SessionBridge } from "./session.js";
import { runStdio } from "./stdio.js";

const argv = process.argv.slice(2);
const root = packageRootOf(import.meta.url);
const version = packageVersion(root);
// stdout is the MCP channel: every log goes to stderr.
const log = (message: string) => process.stderr.write(`tripezgo-mcp: ${message}\n`);

if (argv[0] === "install") {
  const code = await runInstall(argv.slice(1), {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    nodePath: stableNodePath(process.execPath),
    packageRoot: root,
    version,
    run: runCommand,
    out: (line) => process.stdout.write(`${line}\n`),
  });
  process.exit(code);
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(0);
}

try {
  const config = parseConfig(argv, process.env, log);
  if (config) {
    // Older app builds copy a command with the address and token in it: bridge to that one address.
    log(`bridging stdio to ${config.baseUrl}/mcp`);
    await runStdio(process.stdin, process.stdout, new Bridge({ ...config, log }));
  } else {
    log(`${version} started; waiting for the AI to connect`);
    const bridge = new SessionBridge({
      appTools: loadAppToolSnapshot(root, log),
      guide: loadGuide(join(root, SKILL_PATH)),
      version,
      log,
    });
    await runStdio(process.stdin, process.stdout, bridge);
  }
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`tripezgo-mcp: ${error.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  throw error;
}
