import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, assertPrivateAddress } from "../src/config.js";
import type { PlanningGuide } from "../src/guide.js";
import { SessionBridge } from "../src/session.js";
import { FakeApp } from "./fakeApp.js";

describe("assertPrivateAddress: connect takes only a literal private IPv4", () => {
  const accepted = [
    "10.0.0.1:8765",
    "10.255.255.254:8765",
    "172.16.0.1:8765",
    "172.31.255.255:8765",
    "192.168.1.23:8765",
    "169.254.10.20:8765",
    "100.64.0.1:8765", // Tailscale, the bottom of 100.64/10
    "100.127.255.254:8765", // and the top
    "http://192.168.1.23:8765",
    "http://192.168.1.23:8765/mcp",
    "https://10.1.2.3:8765",
  ];
  for (const address of accepted) {
    it(`accepts ${address}`, () => {
      expect(() => assertPrivateAddress(address)).not.toThrow();
    });
  }

  const rejected = [
    ["a hostname", "my-iphone.local:8765"],
    ["a public hostname", "example.com:8765"],
    ["localhost", "localhost:8765"],
    ["a public IPv4", "8.8.8.8:8765"],
    ["loopback", "127.0.0.1:8765"],
    ["the unspecified address", "0.0.0.0:8765"],
    ["172.15 (just below 172.16/12)", "172.15.0.1:8765"],
    ["172.32 (just above 172.16/12)", "172.32.0.1:8765"],
    ["100.63 (just below 100.64/10)", "100.63.0.1:8765"],
    ["100.128 (just above 100.64/10)", "100.128.0.1:8765"],
    ["169.253", "169.253.0.1:8765"],
    ["192.169", "192.169.0.1:8765"],
    ["a decimal-integer IP", "3232235777:8765"],
    ["a hex IP", "0xc0.0xa8.1.23:8765"],
    ["an octal-looking octet", "010.0.0.1:8765"],
    ["a leading-zero octet", "192.168.01.1:8765"],
    ["an octet above 255", "192.168.1.256:8765"],
    ["too few octets", "192.168.1:8765"],
    ["IPv6", "[fd00::1]:8765"],
    ["IPv6 loopback", "[::1]:8765"],
    ["an IPv4-mapped IPv6", "[::ffff:192.168.1.5]:8765"],
    ["userinfo that hides another host", "192.168.1.5@evil.example:8765"],
    ["a private-looking hostname", "192.168.1.5.evil.example:8765"],
    ["a non-http scheme", "ftp://192.168.1.5:8765"],
  ] as const;
  for (const [what, address] of rejected) {
    it(`rejects ${what}: ${address}`, () => {
      expect(() => assertPrivateAddress(address)).toThrow(ConfigError);
    });
  }

  it("says what is accepted and why hostnames are not", () => {
    expect(() => assertPrivateAddress("example.com:8765")).toThrow(/literal IPv4.*10\..*172\.16.*192\.168.*169\.254.*100\.64/s);
    expect(() => assertPrivateAddress("example.com:8765")).toThrow(/hostname/i);
  });
});

const GUIDE: PlanningGuide = { topics: [], full: () => "", topic: () => undefined };
const call = (address: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "connect", arguments: { address, token: "tok" } } });

describe("SessionBridge connect refuses an address outside the private ranges", () => {
  let app: FakeApp;
  let baseUrl: string;
  let bridge: SessionBridge;

  beforeEach(async () => {
    app = new FakeApp();
    baseUrl = await app.start();
    bridge = new SessionBridge({ appTools: [], guide: GUIDE, version: "0.2.0" });
  });
  afterEach(async () => {
    await app.stop();
  });

  it("answers with a tool error and sends nothing, not even to a live loopback listener", async () => {
    for (const address of [baseUrl, baseUrl.replace("127.0.0.1", "localhost"), "example.com:8765", "8.8.8.8:8765"]) {
      const reply = JSON.parse((await bridge.handle(call(address)))[0]);
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/private/i);
    }
    expect(app.requests).toHaveLength(0);
  });
});
