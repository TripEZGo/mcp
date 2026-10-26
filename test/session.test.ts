import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanningGuide } from "../src/guide.js";
import { SessionBridge } from "../src/session.js";
import { FakeApp, closedPortUrl, json, type RecordedRequest } from "./fakeApp.js";

const TOKEN = "tok-session";
const SNAPSHOT = [
  { name: "list_trips", description: "List trips", inputSchema: { type: "object", properties: {} } },
  { name: "create_trip", description: "Create a trip", inputSchema: { type: "object", properties: {} } },
];
const GUIDE: PlanningGuide = {
  topics: ["planning", "sources"],
  full: () => "GUIDE BODY\n\nPLANNING\n\nSOURCES",
  topic: (name) => ({ planning: "PLANNING", sources: "SOURCES" })[name],
};

const CLIENT_INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } },
};

let nextId = 100;
const call = (name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });

/** The app's /mcp, as far as the bridge needs it. `tools` are the tools this app version has. */
function appHandler(options: { token?: string; tools?: string[]; toolList?: (msg: { params?: { cursor?: string } }) => unknown } = {}) {
  const token = options.token ?? TOKEN;
  const tools = options.tools ?? ["list_trips", "create_trip"];
  return (req: RecordedRequest) => {
    if (req.headers.authorization !== `Bearer ${token}`) return { status: 401 };
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
            instructions: "APP INSTRUCTIONS",
            _meta: { "tripezgo/apiLevel": 1, "tripezgo/uploadLimitBytes": 1024 * 1024 },
          },
        },
        { "Mcp-Session-Id": `session-${token}` },
      );
    }
    if (msg.method === "tools/call") {
      if (!tools.includes(msg.params.name)) {
        return json(200, {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Unknown tool: ${msg.params.name}. Call tools/list to see the tools.` },
        });
      }
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `ran ${msg.params.name}` }] } });
    }
    if (msg.method === "tools/list" && options.toolList) {
      const reply = options.toolList(msg);
      return typeof reply === "number" ? { status: reply } : json(200, { jsonrpc: "2.0", id: msg.id, result: reply });
    }
    return json(200, { jsonrpc: "2.0", id: msg.id, result: {} });
  };
}

function parse(lines: string[]) {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe("SessionBridge before connecting", () => {
  let bridge: SessionBridge;

  beforeEach(() => {
    bridge = new SessionBridge({ appTools: SNAPSHOT, guide: GUIDE, version: "0.2.0" });
  });

  it("answers initialize itself with the client's protocol version, TripEZGo serverInfo and how to connect", async () => {
    const reply = parse(await bridge.handle(JSON.stringify(CLIENT_INIT)));

    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe("2025-06-18");
    expect(reply.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(reply.result.serverInfo).toEqual({ name: "TripEZGo", version: "0.2.0" });
    expect(reply.result.instructions).toMatch(/connect/);
    expect(reply.result.instructions).toMatch(/連接 TripEZGo/);
    expect(reply.result.instructions).toMatch(/get_planning_guide/);
  });

  it("answers a protocol version it doesn't know with its newest one", async () => {
    const reply = parse(
      await bridge.handle(JSON.stringify({ ...CLIENT_INIT, params: { ...CLIENT_INIT.params, protocolVersion: "1999-01-01" } })),
    );
    expect(reply.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists connect, the planning guide, the built-in snapshot of the app's tools and the local upload tool", async () => {
    const reply = parse(await bridge.handle('{"jsonrpc":"2.0","id":2,"method":"tools/list"}'));

    const names = reply.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["connect", "get_planning_guide", "list_trips", "create_trip", "add_attachment_from_path"]);
    const connect = reply.result.tools[0];
    expect(connect.inputSchema.required).toEqual(["address", "token"]);
    const guide = reply.result.tools[1];
    expect(guide.inputSchema.properties.topic.enum).toEqual(["planning", "sources"]);
  });

  it("omits the topic enum when the guide couldn't be read, instead of an empty enum no value satisfies", async () => {
    const empty = new SessionBridge({
      appTools: [],
      guide: { topics: [], full: () => "missing", topic: () => undefined },
      version: "0.2.1",
    });
    const reply = parse(await empty.handle('{"jsonrpc":"2.0","id":2,"method":"tools/list"}'));
    const guide = reply.result.tools.find((t: { name: string }) => t.name === "get_planning_guide");
    expect(guide.inputSchema.properties.topic).not.toHaveProperty("enum");
    expect(guide.inputSchema.properties.topic.type).toBe("string");
  });

  // The app's connect sentence in each of its languages (zh-Hant-TW and zh-Hant-HK share one).
  const SENTENCES = [
    "連接 TripEZGo：192.168.1.23:8765，金鑰",
    "连接 TripEZGo：192.168.1.23:8765，密钥",
    "Connect to TripEZGo: 192.168.1.23:8765, key",
    "TripEZGo に接続：192.168.1.23:8765、キー",
    "TripEZGo 연결: 192.168.1.23:8765, 키",
  ];

  it("teaches the connect sentence in every app language, in the instructions and the connect tool", async () => {
    const init = parse(await bridge.handle(JSON.stringify(CLIENT_INIT)));
    const list = parse(await bridge.handle('{"jsonrpc":"2.0","id":2,"method":"tools/list"}'));
    const connect = list.result.tools.find((t: { name: string }) => t.name === "connect");
    for (const sentence of SENTENCES) {
      expect(init.result.instructions).toContain(sentence);
      expect(connect.description).toContain(sentence);
    }
  });

  it("answers ping and swallows notifications without any network", async () => {
    expect(parse(await bridge.handle('{"jsonrpc":"2.0","id":3,"method":"ping"}'))).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await bridge.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual([]);
  });

  it("says Method not found for anything else", async () => {
    expect(parse(await bridge.handle('{"jsonrpc":"2.0","id":4,"method":"resources/list"}')).error.code).toBe(-32601);
  });

  it("answers an app tool with a tool error that tells the user how to connect", async () => {
    const reply = parse(await bridge.handle(call("list_trips")));

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/Not connected/);
    expect(reply.result.content[0].text).toMatch(/Connect computer AI/);
    expect(reply.result.content[0].text).toMatch(/connect/);
  });

  it("answers add_attachment_from_path with the same tool error", async () => {
    const reply = parse(await bridge.handle(call("add_attachment_from_path", { path: "/tmp/x.pdf" })));
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/Not connected/);
  });

  it("serves the planning guide, whole or by topic, without a connection", async () => {
    const whole = parse(await bridge.handle(call("get_planning_guide")));
    expect(whole.result.content[0].text).toBe("GUIDE BODY\n\nPLANNING\n\nSOURCES");

    const one = parse(await bridge.handle(call("get_planning_guide", { topic: "sources" })));
    expect(one.result.content[0].text).toBe("SOURCES");

    const unknown = parse(await bridge.handle(call("get_planning_guide", { topic: "nope" })));
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toMatch(/planning, sources/);
  });

  it("answers a parse error and an unknown tools/call name without crashing", async () => {
    expect(parse(await bridge.handle("{oops")).error.code).toBe(-32700);
    expect(parse(await bridge.handle('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}')).error.code).toBe(-32602);
  });
});

describe("SessionBridge connect", () => {
  let app: FakeApp;
  let baseUrl: string;
  let bridge: SessionBridge;

  beforeEach(async () => {
    app = new FakeApp(TOKEN);
    app.handler = appHandler();
    baseUrl = await app.start();
    bridge = new SessionBridge({ appTools: SNAPSHOT, guide: GUIDE, version: "0.2.0", allowLoopback: true });
    await bridge.handle(JSON.stringify(CLIENT_INIT));
  });

  afterEach(async () => {
    await app.stop();
  });

  it("initializes against the app with the real client's clientInfo, then sends notifications/initialized", async () => {
    const reply = parse(await bridge.handle(call("connect", { address: baseUrl.replace("http://", ""), token: TOKEN })));

    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content[0].text).toMatch(/1\.4\.0/);
    expect(reply.result.content[0].text).toMatch(/APP INSTRUCTIONS/);
    const bodies = app.requests.map((r) => JSON.parse(r.body.toString()));
    expect(bodies.map((b) => b.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(bodies[0].params.clientInfo).toEqual({ name: "claude-code", version: "2.1.0" });
    expect(bodies[0].params.protocolVersion).toBe("2025-06-18");
    expect(app.requests[0].path).toBe("/mcp");
    expect(app.requests[1].headers["mcp-session-id"]).toBe(`session-${TOKEN}`);
  });

  it("accepts http://IP:PORT and the /mcp address too", async () => {
    expect(parse(await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }))).result.isError).toBeFalsy();
    expect(parse(await bridge.handle(call("connect", { address: `${baseUrl}/mcp`, token: TOKEN }))).result.isError).toBeFalsy();
  });

  it("forwards app tools after connecting, with the token, session id and protocol version", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    const line = call("list_trips", { x: "é 旅程" });

    const reply = parse(await bridge.handle(line));

    expect(reply.result.content[0].text).toBe("ran list_trips");
    const last = app.requests.at(-1)!;
    expect(last.body.toString()).toBe(line);
    expect(last.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(last.headers["mcp-session-id"]).toBe(`session-${TOKEN}`);
    expect(last.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("turns the app's Unknown tool error into a tool error that says to update the app", async () => {
    app.handler = appHandler({ tools: ["list_trips"] });
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));

    const reply = parse(await bridge.handle(call("create_trip")));

    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/create_trip/);
    expect(reply.result.content[0].text).toMatch(/1\.4\.0/);
    expect(reply.result.content[0].text).toMatch(/App Store/);
  });

  it("passes other JSON-RPC errors from the app through unchanged", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    const body = '{"jsonrpc":"2.0","id":77,"error":{"code":-32602,"message":"dayNumber must be 1 or more."}}';
    app.handler = () => json(200, body);

    expect(await bridge.handle(call("list_trips"))).toEqual([body]);
  });

  it("answers a wrong key with a tool error asking for a fresh sentence, and stays unconnected", async () => {
    const reply = parse(await bridge.handle(call("connect", { address: baseUrl, token: "wrong" })));

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/key is wrong/);
    expect(reply.result.content[0].text).toMatch(/connect sentence/);
    expect(parse(await bridge.handle(call("list_trips"))).result.content[0].text).toMatch(/Not connected/);
  });

  it("answers an unreachable address with the same-Wi-Fi hint", async () => {
    const reply = parse(await bridge.handle(call("connect", { address: await closedPortUrl(), token: TOKEN })));

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/same Wi-Fi/);
    // The phone may have moved to another Wi-Fi or reopened the page: the address in hand is stale.
    expect(reply.result.content[0].text).toMatch(/copy the latest connect sentence from the iPhone and paste it again/);
  });

  it("forgets the connection when an upload is refused with 401", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    const dir = await mkdtemp(join(tmpdir(), "tripezgo-session-"));
    try {
      const file = join(dir, "a.pdf");
      await writeFile(file, Buffer.from([1]));
      app.handler = () => ({ status: 401 });

      const reply = parse(await bridge.handle(call("add_attachment_from_path", { path: file })));

      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/connect sentence/);
      expect(parse(await bridge.handle(call("list_trips"))).result.content[0].text).toMatch(/Not connected/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the connection when an upload fails for another reason", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    expect(parse(await bridge.handle(call("add_attachment_from_path", { path: "/no/such/file.pdf" }))).result.isError).toBe(true);
    expect(parse(await bridge.handle(call("list_trips"))).result.content[0].text).toBe("ran list_trips");
  });

  it("refuses a missing or malformed address or token without calling anything", async () => {
    for (const args of [{}, { address: baseUrl }, { token: TOKEN }, { address: "http://[bad", token: TOKEN }]) {
      expect(parse(await bridge.handle(call("connect", args))).result.isError).toBe(true);
    }
    expect(app.requests).toHaveLength(0);
  });

  it("asks to reconnect when the app later answers 401, and forgets the connection", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    app.handler = () => ({ status: 401 });

    const reply = parse(await bridge.handle(call("list_trips")));

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/connect sentence/);
    expect(parse(await bridge.handle(call("list_trips"))).result.content[0].text).toMatch(/Not connected/);
  });

  it("keeps the connection when the phone is only out of reach for a moment", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    await app.stop();

    const reply = parse(await bridge.handle(call("list_trips")));
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/same Wi-Fi/);

    // Same port again: the phone came back.
    const port = Number(new URL(baseUrl).port);
    await new Promise<void>((resolve) => (app as unknown as { server: import("node:https").Server }).server.listen(port, "127.0.0.1", resolve));
    expect(parse(await bridge.handle(call("list_trips"))).result.content[0].text).toBe("ran list_trips");
  });

  it("replaces the old connection when connect is called again with a new address and token", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    const second = new FakeApp("second-token");
    second.handler = appHandler({ token: "second-token" });
    const secondUrl = await second.start();
    try {
      const reply = parse(await bridge.handle(call("connect", { address: secondUrl, token: "second-token" })));
      expect(reply.result.isError).toBeFalsy();

      await bridge.handle(call("list_trips"));

      expect(second.requests.at(-1)!.headers["mcp-session-id"]).toBe("session-second-token");
      expect(app.requests.filter((r) => JSON.parse(r.body.toString()).method === "tools/call")).toHaveLength(0);
    } finally {
      await second.stop();
    }
  });

  it("uploads with the connection's address, token and the app's upload limit", async () => {
    await bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
    const list = parse(await bridge.handle('{"jsonrpc":"2.0","id":9,"method":"tools/list"}'));
    const local = list.result.tools.find((t: { name: string }) => t.name === "add_attachment_from_path");
    expect(local.description).toContain("up to 1 MB");

    const dir = await mkdtemp(join(tmpdir(), "tripezgo-session-"));
    try {
      const file = join(dir, "a.pdf");
      await writeFile(file, Buffer.from([1, 2, 3]));
      app.handler = (req) =>
        req.path === "/upload" ? json(200, { attachmentId: "A-1", name: "a.pdf", byteCount: 3 }) : { status: 500 };

      const reply = parse(await bridge.handle(call("add_attachment_from_path", { path: file })));

      expect(reply.result.isError).toBeFalsy();
      const upload = app.requests.at(-1)!;
      expect(upload.path).toBe("/upload");
      expect(upload.headers.authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const LIST_CHANGED = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
/** What a 1.4.1 app lists: no `days` on create_trip. */
const OLD_APP_TOOLS = [
  { name: "list_trips", description: "old list", inputSchema: { type: "object", properties: {} } },
  {
    name: "create_trip",
    description: "old create",
    inputSchema: { type: "object", properties: { name: { type: "string" }, placeId: { type: "string" } }, required: ["name"] },
  },
  { name: "connect", description: "app's own", inputSchema: { type: "object" } },
  { name: "free_form", description: "open", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
  { name: "no_props", description: "no props", inputSchema: { type: "object" } },
];

describe("SessionBridge with the app's own tool list", () => {
  let app: FakeApp;
  let baseUrl: string;
  let bridge: SessionBridge;
  const logs: string[] = [];
  const listTools = async () =>
    parse(await bridge.handle('{"jsonrpc":"2.0","id":9,"method":"tools/list"}')).result.tools as { name: string; description: string }[];
  const connect = () => bridge.handle(call("connect", { address: baseUrl, token: TOKEN }));
  const calls = () => app.requests.map((r) => JSON.parse(r.body.toString())).filter((m) => m.method === "tools/call");

  beforeEach(async () => {
    logs.length = 0;
    app = new FakeApp(TOKEN);
    app.handler = appHandler({ tools: ["list_trips", "create_trip", "free_form", "no_props"], toolList: () => ({ tools: OLD_APP_TOOLS }) });
    baseUrl = await app.start();
    bridge = new SessionBridge({ appTools: SNAPSHOT, guide: GUIDE, version: "0.2.0", allowLoopback: true, log: (m) => logs.push(m) });
    await bridge.handle(JSON.stringify(CLIENT_INIT));
  });

  afterEach(async () => {
    await app.stop();
  });

  it("asks the app for its tools with the session headers, lists them instead of the snapshot, and says the list changed", async () => {
    const lines = await connect();

    expect(JSON.parse(lines[0]).result.isError).toBeFalsy();
    expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([LIST_CHANGED]);
    const request = app.requests.at(-1)!;
    expect(JSON.parse(request.body.toString()).method).toBe("tools/list");
    expect(request.headers["mcp-session-id"]).toBe(`session-${TOKEN}`);
    expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");

    const tools = await listTools();
    expect(tools.find((t) => t.name === "create_trip")!.description).toBe("old create");
    expect(tools.filter((t) => t.name === "connect")).toHaveLength(1);
    expect(tools.find((t) => t.name === "connect")!.description).not.toBe("app's own");
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["connect", "get_planning_guide", "list_trips", "create_trip", "add_attachment_from_path"]),
    );
    // Only the reply to connect carries the notification.
    expect(await bridge.handle('{"jsonrpc":"2.0","id":10,"method":"ping"}')).toHaveLength(1);
  });

  it("follows nextCursor to the end", async () => {
    app.handler = appHandler({
      toolList: (msg) =>
        msg.params?.cursor === "p2" ? { tools: [OLD_APP_TOOLS[1]] } : { tools: [OLD_APP_TOOLS[0]], nextCursor: "p2" },
    });
    await connect();
    expect((await listTools()).map((t) => t.name)).toEqual(expect.arrayContaining(["list_trips", "create_trip"]));
    expect(app.requests.filter((r) => JSON.parse(r.body.toString()).method === "tools/list")).toHaveLength(2);
  });

  it("refuses a top-level argument the app's schema doesn't list, without sending it, and names the version and accepted names", async () => {
    await connect();
    const before = calls().length;

    const reply = parse(await bridge.handle(call("create_trip", { name: "Kyoto", days: [{ day: 1 }] })));

    expect(reply.result.isError).toBe(true);
    const text = reply.result.content[0].text;
    expect(text).toContain("1.4.0");
    expect(text).toContain("`days`");
    expect(text).toContain("`name`");
    expect(text).toContain("`placeId`");
    expect(calls()).toHaveLength(before);
  });

  it("forwards a call that only uses listed arguments, byte for byte", async () => {
    await connect();
    const line = call("create_trip", { name: "Kyoto", placeId: "p1" });

    const reply = parse(await bridge.handle(line));

    expect(reply.result.content[0].text).toBe("ran create_trip");
    expect(app.requests.at(-1)!.body.toString()).toBe(line);
  });

  it("does not check a schema without properties or with additionalProperties: true", async () => {
    await connect();
    expect(parse(await bridge.handle(call("free_form", { anything: 1 }))).result.isError).toBeFalsy();
    expect(parse(await bridge.handle(call("no_props", { anything: 1 }))).result.isError).toBeFalsy();
  });

  it("answers a tool the app's list lacks with the update message, without sending it", async () => {
    await connect();
    const before = calls().length;
    const reply = parse(await bridge.handle(call("get_trip")));
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/App Store/);
    expect(calls()).toHaveLength(before);
  });

  it.each([
    ["an HTTP error", () => 500],
    ["a malformed answer", () => ({ nope: true })],
    ["a tool without a schema", () => ({ tools: [{ name: "x" }] })],
    ["an empty list", () => ({ tools: [] })],
  ])("falls back to the snapshot and forwards calls as today when tools/list gives %s", async (_label, toolList) => {
    app.handler = appHandler({ toolList });

    const lines = await connect();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).result.isError).toBeFalsy();
    expect(logs.some((m) => /tools\/list/.test(m))).toBe(true);
    expect((await listTools()).find((t) => t.name === "create_trip")!.description).toBe("Create a trip");
    const reply = parse(await bridge.handle(call("create_trip", { name: "x", days: [] })));
    expect(reply.result.content[0].text).toBe("ran create_trip");
  });

  it("falls back to the snapshot when the app gives no result to tools/list", async () => {
    bridge = new SessionBridge({ appTools: SNAPSHOT, guide: GUIDE, version: "0.2.0", allowLoopback: true, timeoutMs: 300, log: (m) => logs.push(m) });
    await bridge.handle(JSON.stringify(CLIENT_INIT));
    const base = appHandler();
    app.handler = (req) => {
      const msg = JSON.parse(req.body.toString());
      if (msg.method !== "tools/list") return base(req);
      return { status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" };
    };
    const lines = await connect();
    expect(lines).toHaveLength(1);
    expect((await listTools()).find((t) => t.name === "create_trip")!.description).toBe("Create a trip");
  });

  it("goes back to the snapshot and says so when the connection is dropped", async () => {
    await connect();
    app.handler = () => ({ status: 401 });

    const lines = await bridge.handle(call("list_trips"));

    expect(JSON.parse(lines[0]).result.isError).toBe(true);
    expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([LIST_CHANGED]);
    expect((await listTools()).find((t) => t.name === "create_trip")!.description).toBe("Create a trip");
  });
});
