import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("reads --url and --token", () => {
    expect(parseConfig(["--url", "http://192.168.1.5:8765", "--token", "abc"], {})).toEqual({
      baseUrl: "http://192.168.1.5:8765",
      token: "abc",
    });
  });

  it("accepts --flag=value", () => {
    expect(parseConfig(["--url=http://10.0.0.2:8765", "--token=xyz"], {}).token).toBe("xyz");
  });

  it("falls back to TRIPEZGO_URL / TRIPEZGO_TOKEN, and flags win over them", () => {
    const env = { TRIPEZGO_URL: "http://10.0.0.9:8765", TRIPEZGO_TOKEN: "env-token" };
    expect(parseConfig([], env)).toEqual({ baseUrl: "http://10.0.0.9:8765", token: "env-token" });
    expect(parseConfig(["--token", "flag-token"], env).token).toBe("flag-token");
  });

  it("tolerates a bare IP:PORT and the /mcp URL meant for direct clients", () => {
    expect(parseConfig(["--url", "192.168.1.5:8765", "--token", "t"], {}).baseUrl).toBe("http://192.168.1.5:8765");
    expect(parseConfig(["--url", "http://192.168.1.5:8765/mcp/", "--token", "t"], {}).baseUrl).toBe(
      "http://192.168.1.5:8765",
    );
  });

  it("rejects missing values and unknown options", () => {
    expect(() => parseConfig(["--token", "t"], {})).toThrow(ConfigError);
    expect(() => parseConfig(["--url", "http://a:1"], {})).toThrow(ConfigError);
    expect(() => parseConfig(["--url", "http://a:1", "--token", "t", "--port", "1"], {})).toThrow(ConfigError);
    expect(() => parseConfig(["--url", "--token", "t"], {})).toThrow(ConfigError);
  });
});
