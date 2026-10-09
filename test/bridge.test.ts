import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge.js";
import { LOCAL_TOOL_NAME } from "../src/upload.js";
import { FakeApp, closedPortUrl, json } from "./fakeApp.js";

const TOKEN = "tok_abc123";

describe("Bridge forwarding", () => {
  let app: FakeApp;
  let bridge: Bridge;
  let logs: string[];

  beforeEach(async () => {
    app = new FakeApp();
    const baseUrl = await app.start();
    logs = [];
    bridge = new Bridge({ baseUrl, token: TOKEN, log: (m) => logs.push(m) });
  });

  afterEach(async () => {
    await app.stop();
  });

  it("posts the stdin line to /mcp byte for byte, with the token, and writes the app's body back unchanged", async () => {
    const line = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_trips","arguments":{"x":"é 旅程"}}}';
    const appBody = '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"[]"}],"_extra":{"keep":true}}}';
    app.handler = () => json(200, appBody);

    const out = await bridge.handle(line);

    expect(out).toEqual([appBody]);
    expect(app.requests).toHaveLength(1);
    const req = app.requests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/mcp");
    expect(req.body.toString("utf8")).toBe(line);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.accept).toBe("application/json, text/event-stream");
  });

  it("keeps the app's Mcp-Session-Id and protocol version from initialize and sends them afterwards", async () => {
    app.handler = (req) => {
      const msg = JSON.parse(req.body.toString());
      if (msg.method === "initialize") {
        return json(
          200,
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "TripEZGo", version: "1.1.0" },
              capabilities: { tools: {} },
              _meta: { "tripezgo/apiLevel": 1 },
            },
          },
          { "Mcp-Session-Id": "session-42" },
        );
      }
      return json(200, { jsonrpc: "2.0", id: msg.id, result: {} });
    };

    const init = await bridge.handle('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}');
    await bridge.handle('{"jsonrpc":"2.0","id":2,"method":"ping"}');

    expect(JSON.parse(init[0]).result._meta).toEqual({ "tripezgo/apiLevel": 1 });
    expect(app.requests[0].headers["mcp-session-id"]).toBeUndefined();
    expect(app.requests[1].headers["mcp-session-id"]).toBe("session-42");
    expect(app.requests[1].headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("writes nothing back for a notification the app accepts with 202", async () => {
    app.handler = () => ({ status: 202 });

    const out = await bridge.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}');

    expect(out).toEqual([]);
    expect(app.requests).toHaveLength(1);
  });

  it("appends add_attachment_from_path to the app's tools/list result and keeps the app's tools", async () => {
    app.handler = () =>
      json(200, {
        jsonrpc: "2.0",
        id: 3,
        result: { tools: [{ name: "list_trips", inputSchema: { type: "object" } }] },
      });

    const out = await bridge.handle('{"jsonrpc":"2.0","id":3,"method":"tools/list"}');

    const names = JSON.parse(out[0]).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_trips", LOCAL_TOOL_NAME]);
    const local = JSON.parse(out[0]).result.tools[1];
    expect(local.inputSchema.required).toEqual(["path"]);
    expect(Object.keys(local.inputSchema.properties)).toEqual(["path", "tripId", "eventId", "name"]);
  });

  it("takes the upload limit from initialize's _meta: the local tool states it and refuses a bigger file", async () => {
    const limit = 1024 * 1024;
    app.handler = (req) => {
      const msg = JSON.parse(req.body.toString());
      if (msg.method === "initialize") {
        return json(200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            _meta: { "tripezgo/apiLevel": 1, "tripezgo/uploadLimitBytes": limit },
          },
        });
      }
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    };
    const dir = await mkdtemp(join(tmpdir(), "tripezgo-mcp-bridge-"));
    const big = join(dir, "big.pdf");
    await writeFile(big, "");
    await truncate(big, limit + 1);

    try {
      await bridge.handle('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}');
      const list = await bridge.handle('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
      const call = await bridge.handle(
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: LOCAL_TOOL_NAME, arguments: { path: big } } }),
      );

      const local = JSON.parse(list[0]).result.tools.find((t: { name: string }) => t.name === LOCAL_TOOL_NAME);
      expect(local.description).toContain("up to 1 MB");
      const reply = JSON.parse(call[0]);
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/limited to 1 MB/);
      expect(app.requests.filter((r) => r.path === "/upload")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("without an upload limit from the app, the local tool states the 20 MB default", async () => {
    app.handler = () => json(200, { jsonrpc: "2.0", id: 2, result: { tools: [] } });

    const list = await bridge.handle('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');

    const local = JSON.parse(list[0]).result.tools.find((t: { name: string }) => t.name === LOCAL_TOOL_NAME);
    expect(local.description).toContain("up to 20 MB");
  });

  it("does not append the local tool to a later tools/list page", async () => {
    const appBody = '{"jsonrpc":"2.0","id":4,"result":{"tools":[{"name":"list_notes"}]}}';
    app.handler = () => json(200, appBody);

    const out = await bridge.handle('{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{"cursor":"page2"}}');

    expect(out).toEqual([appBody]);
  });

  it("handles a tools/call of add_attachment_from_path locally instead of forwarding it to /mcp", async () => {
    const out = await bridge.handle(
      `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"${LOCAL_TOOL_NAME}","arguments":{"path":"/definitely/not/here.pdf"}}}`,
    );

    expect(app.requests.filter((r) => r.path === "/mcp")).toHaveLength(0);
    const reply = JSON.parse(out[0]);
    expect(reply.id).toBe(5);
    expect(reply.result.isError).toBe(true);
  });

  it("squeezes a pretty-printed app body onto one line so stdio framing holds", async () => {
    app.handler = () => json(200, JSON.stringify({ jsonrpc: "2.0", id: 6, result: { a: 1 } }, null, 2));

    const out = await bridge.handle('{"jsonrpc":"2.0","id":6,"method":"ping"}');

    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/\n/);
    expect(JSON.parse(out[0])).toEqual({ jsonrpc: "2.0", id: 6, result: { a: 1 } });
  });

  it("reads a text/event-stream answer too", async () => {
    app.handler = () => ({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":8,"result":{}}\n\n',
    });

    const out = await bridge.handle('{"jsonrpc":"2.0","id":8,"method":"ping"}');

    expect(out).toEqual(['{"jsonrpc":"2.0","id":8,"result":{}}']);
  });

  it("passes a JSON-RPC error body from the app through even on a 4xx", async () => {
    const appBody = '{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"Method not found"}}';
    app.handler = () => json(404, appBody);

    expect(await bridge.handle('{"jsonrpc":"2.0","id":9,"method":"nope"}')).toEqual([appBody]);
  });

  it("turns a 401 into a JSON-RPC error that explains the token", async () => {
    app.handler = () => ({ status: 401 });

    const out = await bridge.handle('{"jsonrpc":"2.0","id":10,"method":"ping"}');

    const reply = JSON.parse(out[0]);
    expect(reply.id).toBe(10);
    expect(reply.error.message).toMatch(/token/);
    expect(reply.error.message).toMatch(/Connect computer AI/);
  });

  it("answers a parse error without calling the app", async () => {
    const out = await bridge.handle("{not json");

    expect(JSON.parse(out[0]).error.code).toBe(-32700);
    expect(app.requests).toHaveLength(0);
  });
});

describe("Bridge when the app is not reachable", () => {
  it("answers a request with an error that says to keep the page open on the same Wi-Fi", async () => {
    const baseUrl = await closedPortUrl();
    const bridge = new Bridge({ baseUrl, token: TOKEN });

    const out = await bridge.handle('{"jsonrpc":"2.0","id":"a","method":"tools/list"}');

    const reply = JSON.parse(out[0]);
    expect(reply.id).toBe("a");
    expect(reply.error.message).toContain(baseUrl);
    expect(reply.error.message).toMatch(/Connect computer AI/);
    expect(reply.error.message).toMatch(/same Wi-Fi/);
  });

  it("logs, and writes nothing, for a notification", async () => {
    const logs: string[] = [];
    const bridge = new Bridge({ baseUrl: await closedPortUrl(), token: TOKEN, log: (m) => logs.push(m) });

    expect(await bridge.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual([]);
    expect(logs[0]).toMatch(/same Wi-Fi/);
  });
});
