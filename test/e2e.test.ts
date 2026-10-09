import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApp, json, type RecordedRequest } from "./fakeApp.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const TOKEN = "e2e-token";

/** Just enough of the app's MCP endpoint for the official SDK client to complete a session. */
function fakeMcp(req: RecordedRequest) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401 };
  if (req.path === "/upload") return json(200, { attachmentId: "A-9", name: req.query.get("name"), byteCount: req.body.length });
  const msg = JSON.parse(req.body.toString());
  if (!("id" in msg)) return { status: 202 };
  switch (msg.method) {
    case "initialize":
      return json(200, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "TripEZGo", version: "1.1.0" },
          _meta: { "tripezgo/apiLevel": 1 },
        },
      });
    case "tools/list":
      return json(200, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "list_trips", inputSchema: { type: "object", properties: {} } }] },
      });
    case "tools/call":
      return json(200, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `called ${msg.params.name}` }] },
      });
    default:
      return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}

describe("the built CLI under the official MCP SDK client (what Claude Desktop does)", () => {
  let app: FakeApp;
  let client: Client;
  let dir: string;

  beforeEach(async () => {
    app = new FakeApp();
    app.handler = fakeMcp;
    const baseUrl = await app.start();
    dir = await mkdtemp(join(tmpdir(), "tripezgo-mcp-e2e-"));
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "--url", baseUrl, "--token", TOKEN], stderr: "ignore" }),
    );
  });

  afterEach(async () => {
    await client.close();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("initializes, lists the app's tools plus the local one, and calls both kinds", async () => {
    expect(client.getServerVersion()?.name).toBe("TripEZGo");

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_trips", "add_attachment_from_path"]);

    const remote = await client.callTool({ name: "list_trips", arguments: {} });
    expect(remote.content).toEqual([{ type: "text", text: "called list_trips" }]);

    const file = join(dir, "ticket.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const local = await client.callTool({ name: "add_attachment_from_path", arguments: { path: file } });
    expect(local.isError).toBeFalsy();
    expect(local.structuredContent).toEqual({ attachmentId: "A-9", name: "ticket.png", byteCount: 3 });

    expect(app.requests.filter((r) => r.path === "/upload")).toHaveLength(1);
    expect(app.requests.filter((r) => r.path === "/mcp").map((r) => JSON.parse(r.body.toString()).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });
});
