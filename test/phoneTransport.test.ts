import { createServer as createPlainServer, type Server as PlainServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBridge } from "../src/session.js";
import { TlsHandshakeError, derivePsk, phoneFetch } from "../src/phoneTransport.js";
import { FakeApp, json } from "./fakeApp.js";

describe("PSK derivation", () => {
  it("is HMAC-SHA256(key, 'tripezgo tls psk v1'): known answer for abc123token", () => {
    expect(derivePsk("abc123token").toString("hex")).toBe("9e721546dc6b827dca89e7e9eec74ea060259773c194a96bc65e260c9c17396b");
    expect(derivePsk("abc123token")).toHaveLength(32);
  });

  it("uses the UTF-8 bytes of the key", () => {
    expect(derivePsk("金鑰").toString("hex")).not.toBe(derivePsk("abc").toString("hex"));
  });
});

describe("phoneFetch", () => {
  const apps: FakeApp[] = [];
  const plain: PlainServer[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.stop()));
    await Promise.all(plain.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function app(key: string): Promise<{ url: string; app: FakeApp }> {
    const a = new FakeApp(key);
    a.handler = () => json(200, { ok: true });
    apps.push(a);
    return { url: await a.start(), app: a };
  }
  const get = (url: string, key: string) => phoneFetch(`${url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "{}" });

  it("talks to a TLS 1.2 PSK server with the key's PSK, sending the bearer token too", async () => {
    const { url, app: a } = await app("abc123token");

    const response = await get(url, "abc123token");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(a.requests[0]!.headers.authorization).toBe("Bearer abc123token");
    expect(a.requests[0]!.body.toString()).toBe("{}");
  });

  it("negotiates TLS 1.2 with PSK-AES128-GCM-SHA256", async () => {
    const { url, app: a } = await app("k");

    await get(url, "k");

    expect(a.requests[0]!.tls).toEqual({ protocol: "TLSv1.2", cipher: "PSK-AES128-GCM-SHA256" });
  });

  it("fails with TlsHandshakeError when the key is wrong", async () => {
    const { url } = await app("right-key");

    await expect(get(url, "wrong-key")).rejects.toBeInstanceOf(TlsHandshakeError);
  });

  it("refuses a plaintext HTTP server: no fallback", async () => {
    let served = 0;
    const server = createPlainServer((_req, res) => {
      served += 1;
      res.end("{}");
    });
    plain.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await expect(get(url, "abc123token")).rejects.toBeInstanceOf(TlsHandshakeError);
    expect(served).toBe(0);
  });

  it("still reports a closed port as unreachable, not as a handshake failure", async () => {
    const server = createPlainServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));

    const error = await get(`http://127.0.0.1:${port}`, "k").catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TlsHandshakeError);
  });

  it("rejects a request with no Bearer key rather than falling back to anything", async () => {
    await expect(phoneFetch("http://127.0.0.1:1/mcp", { method: "POST" })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("connect over TLS-PSK", () => {
  const apps: FakeApp[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.stop()));
  });
  const call = (address: string, token: string) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "connect", arguments: { address, token } } });

  it("tells the AI to update the app and paste a fresh sentence when the handshake fails (wrong key or old app)", async () => {
    const a = new FakeApp("right-key");
    apps.push(a);
    const url = await a.start();
    const bridge = new SessionBridge({ appTools: [], guide: { full: () => "", topic: () => undefined, topics: [] }, version: "0.3.0", allowLoopback: true });

    const reply = JSON.parse((await bridge.handle(call(url, "wrong-key")))[0]!);

    expect(reply.result.isError).toBe(true);
    const text: string = reply.result.content[0].text;
    expect(text).toMatch(/too old/);
    expect(text).toMatch(/key is wrong/);
    expect(text).toMatch(/update TripEZGo/);
    expect(text).toMatch(/fresh connect sentence/);
    expect(a.requests).toHaveLength(0);
  });
});
