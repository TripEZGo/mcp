#!/usr/bin/env node
// Copies the app's tool list into snapshot/app-tools.json, after checking it.
//
//   node scripts/sync-app-tools.mjs <path-to-app-json> [--out <path>]
//
// The input is the app's `tools/list` result: `{"tools":[…]}`, or the whole JSON-RPC response
// (`{"jsonrpc":"2.0","id":…,"result":{"tools":[…]}}`). The snapshot is what the bridge lists before it is
// connected, so it must be exactly the app's tools — nothing added, nothing renamed.
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_TOOLS = new Set(["connect", "get_planning_guide", "add_attachment_from_path"]);

function fail(message) {
  process.stderr.write(`sync-app-tools: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
let out = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshot", "app-tools.json");
const outAt = args.indexOf("--out");
if (outAt !== -1) {
  out = args[outAt + 1];
  args.splice(outAt, 2);
}
if (args.length !== 1 || !out) fail("usage: node scripts/sync-app-tools.mjs <path-to-app-json> [--out <path>]");

let input;
try {
  input = JSON.parse(await readFile(args[0], "utf8"));
} catch (error) {
  fail(`can't read ${args[0]} as JSON: ${error.message}`);
}

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const result = isObject(input) && isObject(input.result) ? input.result : input;
if (!isObject(result) || !Array.isArray(result.tools)) fail('expected {"tools":[…]} or a JSON-RPC response with result.tools');
if (result.nextCursor) fail("the list has a nextCursor: give the complete list, not one page");

const names = new Set();
result.tools.forEach((tool, index) => {
  const where = `tools[${index}]`;
  if (!isObject(tool)) fail(`${where} is not an object`);
  if (typeof tool.name !== "string" || tool.name === "") fail(`${where} has no name`);
  if (names.has(tool.name)) fail(`${where}: ${tool.name} appears twice`);
  if (LOCAL_TOOLS.has(tool.name)) fail(`${where}: ${tool.name} is a bridge tool's name; the app must not use it`);
  if (!isObject(tool.inputSchema) || tool.inputSchema.type !== "object") fail(`${where} (${tool.name}): inputSchema must be an object schema`);
  names.add(tool.name);
});

const temp = `${out}.tmp-${process.pid}`;
await writeFile(temp, `${JSON.stringify({ tools: result.tools }, null, 2)}\n`);
await rename(temp, out);
process.stdout.write(`sync-app-tools: wrote ${result.tools.length} tools to ${out}\n`);
