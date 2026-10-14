import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGuide } from "../src/guide.js";
import { loadAppToolSnapshot } from "../src/package.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

describe("loadGuide on the repo's skill", () => {
  const guide = loadGuide(join(REPO, "skills", "tripezgo"));

  it("serves SKILL.md without its front matter, followed by every reference", () => {
    const full = guide.full();
    expect(full.startsWith("# TripEZGo")).toBe(true);
    expect(full).not.toMatch(/^name: tripezgo/m);
    for (const topic of guide.topics) expect(full).toContain(`references/${topic}.md`);
  });

  it("names the references as topics", () => {
    expect(guide.topics).toEqual(["planning", "sources", "writing-to-the-app"]);
    expect(guide.topic("planning")).toBeTruthy();
    expect(guide.topic("nope")).toBeUndefined();
  });

  it("says the guide is missing rather than throwing when the folder isn't there", () => {
    expect(loadGuide("/nowhere/tripezgo").full()).toMatch(/missing/);
  });
});

describe("snapshot", () => {
  it("the committed snapshot is valid", async () => {
    const value = JSON.parse(await readFile(join(REPO, "snapshot", "app-tools.json"), "utf8"));
    expect(Array.isArray(value.tools)).toBe(true);
  });

  it("loads to no tools when the file is missing", () => {
    const logs: string[] = [];
    expect(loadAppToolSnapshot("/nowhere", (m) => logs.push(m))).toEqual([]);
    expect(logs[0]).toMatch(/app-tools\.json/);
  });
});

describe("scripts/sync-app-tools.mjs", () => {
  let dir: string;
  const script = join(REPO, "scripts", "sync-app-tools.mjs");
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tripezgo-sync-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function sync(input: unknown): Promise<{ ok: boolean; out?: unknown; stderr: string }> {
    const from = join(dir, "in.json");
    const to = join(dir, "out.json");
    await writeFile(from, typeof input === "string" ? input : JSON.stringify(input));
    try {
      await run(process.execPath, [script, from, "--out", to]);
      return { ok: true, out: JSON.parse(await readFile(to, "utf8")), stderr: "" };
    } catch (error) {
      return { ok: false, stderr: String((error as { stderr?: string }).stderr) };
    }
  }

  it("copies a tools/list result, or the whole JSON-RPC response, as {tools}", async () => {
    expect((await sync({ tools: [tool("list_trips")] })).out).toEqual({ tools: [tool("list_trips")] });
    expect((await sync({ jsonrpc: "2.0", id: 1, result: { tools: [tool("a"), tool("b")] } })).out).toEqual({
      tools: [tool("a"), tool("b")],
    });
  });

  it("refuses bad input and writes nothing", async () => {
    for (const bad of [
      "not json",
      { nope: [] },
      { tools: [tool("a"), tool("a")] },
      { tools: [tool("connect")] },
      { tools: [{ name: "x" }] },
      { tools: [tool("a")], nextCursor: "2" },
    ]) {
      const result = await sync(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(result.stderr).toMatch(/sync-app-tools:/);
    }
  });
});
