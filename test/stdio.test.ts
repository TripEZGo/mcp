import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge.js";
import { runStdio } from "../src/stdio.js";
import { FakeApp, json } from "./fakeApp.js";

describe("runStdio", () => {
  let app: FakeApp;
  let baseUrl: string;

  beforeEach(async () => {
    app = new FakeApp();
    baseUrl = await app.start();
  });

  afterEach(async () => {
    await app.stop();
  });

  it("answers each stdin line on its own stdout line, in order, and skips notifications", async () => {
    app.handler = (req) => {
      const msg = JSON.parse(req.body.toString());
      if (!("id" in msg)) return { status: 202 };
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } });
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => (written += chunk.toString()));

    const done = runStdio(input, output, new Bridge({ baseUrl, token: "t" }));
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write("\n");
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    input.end();
    await done;

    const lines = written.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 1, result: { echo: "initialize" } },
      { jsonrpc: "2.0", id: 2, result: { echo: "ping" } },
    ]);
    expect(app.requests.map((r) => JSON.parse(r.body.toString()).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "ping",
    ]);
  });
});
