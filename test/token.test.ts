import { describe, expect, it } from "vitest";
import { USAGE, parseConfig } from "../src/config.js";

describe("the token comes from TRIPEZGO_TOKEN; --token is deprecated but still works", () => {
  const url = ["--url", "http://192.168.1.5:8765"];

  it("reads TRIPEZGO_TOKEN without any warning", () => {
    const warnings: string[] = [];
    const config = parseConfig(url, { TRIPEZGO_TOKEN: "env-token" }, (m) => warnings.push(m));
    expect(config).toEqual({ baseUrl: "http://192.168.1.5:8765", token: "env-token" });
    expect(warnings).toEqual([]);
  });

  it("still accepts --token and --token=, each with one deprecation warning that names the variable", () => {
    for (const args of [[...url, "--token", "flag-token"], [...url, "--token=flag-token"]]) {
      const warnings: string[] = [];
      expect(parseConfig(args, {}, (m) => warnings.push(m))!.token).toBe("flag-token");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/--token is deprecated/);
      expect(warnings[0]).toContain("TRIPEZGO_TOKEN");
      expect(warnings[0]).not.toContain("flag-token");
    }
  });

  it("the flag still wins over the variable, and still warns", () => {
    const warnings: string[] = [];
    expect(parseConfig([...url, "--token", "flag"], { TRIPEZGO_TOKEN: "env" }, (m) => warnings.push(m))!.token).toBe("flag");
    expect(warnings).toHaveLength(1);
  });

  it("works without a warn callback", () => {
    expect(parseConfig([...url, "--token", "t"], {})!.token).toBe("t");
  });

  it("the usage shows the variable form and calls --token deprecated", () => {
    expect(USAGE).toContain("TRIPEZGO_TOKEN=");
    expect(USAGE).toMatch(/--token.*deprecated/is);
  });
});
