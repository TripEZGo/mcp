import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableNodePath } from "../src/install.js";
import { FakeApp, json, privateLanIPv4, type RecordedRequest } from "./fakeApp.js";

const LAN = privateLanIPv4();

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "e2e-token";
const run = promisify(execFile);
const VERSION: string = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

const APP_TOOLS = [
  { name: "list_trips", description: "List trips", inputSchema: { type: "object", properties: {} } },
  { name: "create_trip", description: "Create a trip", inputSchema: { type: "object", properties: {} } },
];

/** The app's /mcp with only list_trips: create_trip is "a tool this app version doesn't have". */
function fakeMcp(req: RecordedRequest) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401 };
  const msg = JSON.parse(req.body.toString());
  if (!("id" in msg)) return { status: 202 };
  if (msg.method === "initialize") {
    return json(
      200,
      {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "TripEZGo", version: "1.4.0" },
          instructions: "You are connected to TripEZGo.",
          _meta: { "tripezgo/apiLevel": 1 },
        },
      },
      { "Mcp-Session-Id": "s-1" },
    );
  }
  if (msg.method === "tools/call" && msg.params.name === "list_trips") {
    return json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"trips":[]}' }] } });
  }
  return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } });
}

/** A release laid out the way a tag tarball (and `versions/<tag>`) is: bundle, skill, snapshot, package.json. */
async function release(dir: string): Promise<void> {
  await mkdir(join(dir, "snapshot"), { recursive: true });
  await cp(join(REPO, "dist"), join(dir, "dist"), { recursive: true });
  await cp(join(REPO, "skills"), join(dir, "skills"), { recursive: true });
  await cp(join(REPO, "package.json"), join(dir, "package.json"));
  await writeFile(join(dir, "snapshot", "app-tools.json"), JSON.stringify({ tools: APP_TOOLS }));
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]).text;

describe("the bundle with no arguments, under the official MCP SDK client", () => {
  let app: FakeApp;
  let baseUrl: string;
  let dir: string;
  let client: Client;

  beforeEach(async () => {
    app = new FakeApp(TOKEN);
    app.handler = fakeMcp;
    // `connect` refuses loopback, so the fake app listens on this machine's private LAN address (when it has one).
    baseUrl = await app.start(LAN ?? "127.0.0.1");
    dir = await mkdtemp(join(tmpdir(), "tripezgo-e2e-once-"));
    await release(join(dir, "pkg"));
  });

  afterEach(async () => {
    await client?.close();
    await app.stop();
    // The first launcher's detached updater may still be finishing its cleanup inside `dir`: retry ENOTEMPTY.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.skipIf(!LAN)("starts unconnected, lists the snapshot, refuses app tools until connect, then forwards them", async () => {
    client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dir, "pkg", "dist", "cli.js")], stderr: "ignore" }));

    expect(client.getServerVersion()).toEqual({ name: "TripEZGo", version: VERSION });
    expect(client.getInstructions()).toMatch(/connect/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["connect", "get_planning_guide", "list_trips", "create_trip", "add_attachment_from_path"]);

    const before = await client.callTool({ name: "list_trips", arguments: {} });
    expect(before.isError).toBe(true);
    expect(text(before)).toMatch(/Not connected/);
    expect(app.requests).toHaveLength(0);

    const guide = await client.callTool({ name: "get_planning_guide", arguments: {} });
    expect(text(guide)).toMatch(/^# TripEZGo/);
    expect(text(guide)).toMatch(/references\/planning\.md/);

    const connected = await client.callTool({ name: "connect", arguments: { address: baseUrl.replace("http://", ""), token: TOKEN } });
    expect(connected.isError).toBeFalsy();
    expect(text(connected)).toMatch(/TripEZGo app 1\.4\.0/);

    const after = await client.callTool({ name: "list_trips", arguments: {} });
    expect(text(after)).toBe('{"trips":[]}');

    const missing = await client.callTool({ name: "create_trip", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/App Store/);

    const init = JSON.parse(app.requests[0].body.toString());
    expect(init.params.clientInfo).toEqual({ name: "claude-code", version: "9.9.9" });
    expect(app.requests.map((r) => JSON.parse(r.body.toString()).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
    ]);
  });

  it.skipIf(!LAN)("runs through the launcher from a cached version, offline, and refreshes the installed skill", async () => {
    const home = join(dir, ".tripezgo");
    await mkdir(home, { recursive: true });
    await cp(join(REPO, "dist", "launcher.mjs"), join(home, "launcher.mjs"));
    await release(join(home, "versions", "v0.2.0"));
    const skillDir = join(dir, "claude", "skills", "tripezgo");
    await writeFile(join(home, "config.json"), JSON.stringify({ clients: { "claude-code": { skillDir } } }));

    client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(home, "launcher.mjs")],
        env: { ...process.env, TRIPEZGO_NO_UPDATE: "1" } as Record<string, string>,
        stderr: "ignore",
      }),
    );

    expect(client.getServerVersion()?.name).toBe("TripEZGo");
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("list_trips");
    await client.callTool({ name: "connect", arguments: { address: baseUrl, token: TOKEN } });
    expect(text(await client.callTool({ name: "list_trips", arguments: {} }))).toBe('{"trips":[]}');
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(await readFile(join(REPO, "skills", "tripezgo", "SKILL.md"), "utf8"));
  });

  it("starts at once on the cached version when a newer tag exists, and has the newer one cached for the next start", async () => {
    const home = join(dir, ".tripezgo");
    await mkdir(home, { recursive: true });
    await cp(join(REPO, "dist", "launcher.mjs"), join(home, "launcher.mjs"));
    await release(join(home, "versions", "v0.2.0"));

    // The newer release, as codeload serves it, reporting itself as 9.9.9.
    const src = join(dir, "release-src");
    await release(join(src, "mcp-9.9.9"));
    await writeFile(join(src, "mcp-9.9.9", "package.json"), '{"name":"tripezgo-mcp","version":"9.9.9"}');
    execFileSync("tar", ["-czf", join(dir, "r.tgz"), "-C", src, "mcp-9.9.9"]);
    const archive = await readFile(join(dir, "r.tgz"));

    // A stand-in GitHub whose download takes 3 s: a launcher that waited for it would start 3 s late.
    let tarballServedAt = Number.POSITIVE_INFINITY;
    const github = createServer((req, res) => {
      if (req.url?.startsWith("/repos/TripEZGo/mcp/tags")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ name: "v0.2.0" }, { name: "v9.9.9" }]));
      } else if (req.url === "/TripEZGo/mcp/tar.gz/refs/tags/v9.9.9") {
        setTimeout(() => {
          tarballServedAt = Date.now();
          res.writeHead(200);
          res.end(archive);
        }, 3000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    const env = { ...process.env, TRIPEZGO_UPDATE_BASE: base } as Record<string, string>;
    delete env.TRIPEZGO_NO_UPDATE;

    try {
      client = new Client({ name: "claude-code", version: "9.9.9" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(home, "launcher.mjs")], env, stderr: "ignore" }));
      const initializedAt = Date.now();

      expect(client.getServerVersion()).toEqual({ name: "TripEZGo", version: VERSION });
      expect(initializedAt).toBeLessThan(tarballServedAt);
      await client.close();

      const deadline = Date.now() + 15_000;
      while (!existsSync(join(home, "versions", "v9.9.9", "dist", "cli.js")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(join(home, "versions", "v9.9.9", "dist", "cli.js"))).toBe(true);

      // The second start only has to run the new version. Its own detached updater would still be writing into
      // `home` while the teardown deletes it (ENOTEMPTY), so it doesn't get one.
      client = new Client({ name: "claude-code", version: "9.9.9" });
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [join(home, "launcher.mjs")], env: { ...env, TRIPEZGO_NO_UPDATE: "1" }, stderr: "ignore" }),
      );
      expect(client.getServerVersion()).toEqual({ name: "TripEZGo", version: "9.9.9" });
    } finally {
      github.close();
    }
  }, 30_000);
});

describe("the bundled installer, in a temporary HOME", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tripezgo-e2e-install-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("installs for Claude Code through a stand-in `claude` command, then for Codex and Claude Desktop", async () => {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    const calls = join(dir, "claude-calls.txt");
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\ncase "$*" in *"--json"*) echo "[]";; esac\nexit 0\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: "" };

    const cli = join(REPO, "dist", "cli.js");
    const claude = await run(process.execPath, [cli, "install", "claude-code"], { env });
    expect(claude.stdout).toMatch(/installed for Claude Code/);
    const launcher = join(home, ".tripezgo", "launcher.mjs");
    expect(await readFile(calls, "utf8")).toContain(`mcp add -s user tripezgo -- ${stableNodePath(process.execPath)} ${launcher}`);
    expect(await readFile(join(home, ".claude", "skills", "tripezgo", "SKILL.md"), "utf8")).toMatch(/TripEZGo/);
    expect(await readFile(join(home, ".tripezgo", "versions", `v${VERSION}`, "dist", "cli.js"), "utf8")).toBe(
      await readFile(cli, "utf8"),
    );

    await run(process.execPath, [cli, "install", "codex"], { env });
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain(`args = [${JSON.stringify(launcher)}]`);

    if (process.platform === "darwin") {
      await run(process.execPath, [cli, "install", "claude-desktop"], { env });
      const desktop = JSON.parse(
        await readFile(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "utf8"),
      );
      expect(desktop.mcpServers.tripezgo).toEqual({ command: stableNodePath(process.execPath), args: [launcher] });
    }

    const config = JSON.parse(await readFile(join(home, ".tripezgo", "config.json"), "utf8"));
    expect(Object.keys(config.clients)).toContain("claude-code");
    expect(Object.keys(config.clients)).toContain("codex");
  });
});
