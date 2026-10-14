import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LauncherDeps, TAGS_URL, prepareVersion, tarballUrl } from "../src/launcherCore.js";

interface Fixture {
  root: string;
  home: string;
  fetched: string[];
  logs: string[];
  tags: unknown;
  tarballs: Map<string, Buffer>;
  deps: LauncherDeps;
}

/** A tag tarball shaped like codeload's: one top folder `mcp-<version>`. */
async function tarball(root: string, tag: string, files: Record<string, string>): Promise<Buffer> {
  const src = await mkdtemp(join(root, "tarsrc-"));
  const top = join(src, `mcp-${tag.slice(1)}`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(top, path, ".."), { recursive: true });
    await writeFile(join(top, path), content);
  }
  const out = join(src, "out.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", src, `mcp-${tag.slice(1)}`]);
  return readFile(out);
}

const goodFiles = (tag: string) => ({
  "dist/cli.js": `// cli ${tag}`,
  "skills/tripezgo/SKILL.md": `skill ${tag}`,
  "package.json": "{}",
});

async function cache(home: string, tag: string): Promise<void> {
  for (const [path, content] of Object.entries(goodFiles(tag))) {
    const file = join(home, "versions", tag, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tripezgo-launcher-"));
  const home = join(root, ".tripezgo");
  await mkdir(home, { recursive: true });
  const f: Fixture = {
    root,
    home,
    fetched: [],
    logs: [],
    tags: [],
    tarballs: new Map(),
    deps: undefined as unknown as LauncherDeps,
  };
  f.deps = {
    home,
    log: (m) => f.logs.push(m),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      f.fetched.push(url);
      if (url === TAGS_URL) {
        if (f.tags instanceof Error) throw f.tags;
        if (f.tags instanceof Response) return f.tags;
        return new Response(JSON.stringify(f.tags), { status: 200 });
      }
      const body = [...f.tarballs].find(([tag]) => url === tarballUrl(tag))?.[1];
      if (!body) return new Response("nope", { status: 404 });
      void init;
      return new Response(new Uint8Array(body), { status: 200 });
    }) as typeof fetch,
  };
  return f;
}

const tagList = (...names: string[]) => names.map((name) => ({ name }));

describe("prepareVersion", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  it("downloads the highest semver tag, extracts it into versions/<tag> and leaves no temp folder behind", async () => {
    f.tags = tagList("v0.2.0", "v0.10.0", "v0.3.0", "latest", "v1.0.0-beta");
    f.tarballs.set("v0.10.0", await tarball(f.root, "v0.10.0", goodFiles("v0.10.0")));

    const picked = await prepareVersion(f.deps);

    expect(picked?.tag).toBe("v0.10.0");
    expect(picked?.dir).toBe(join(f.home, "versions", "v0.10.0"));
    expect(await readFile(join(f.home, "versions", "v0.10.0", "dist", "cli.js"), "utf8")).toBe("// cli v0.10.0");
    expect(f.fetched).toEqual([TAGS_URL, tarballUrl("v0.10.0")]);
    expect(existsSync(join(f.home, "tmp")) ? await readdir(join(f.home, "tmp")) : []).toEqual([]);
  });

  it("doesn't download a tag already in the cache", async () => {
    await cache(f.home, "v0.3.0");
    f.tags = tagList("v0.3.0");

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.3.0");
    expect(f.fetched).toEqual([TAGS_URL]);
  });

  it("uses the newest cached version when offline", async () => {
    await cache(f.home, "v0.2.0");
    await cache(f.home, "v0.3.0");
    f.tags = new TypeError("fetch failed");

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.3.0");
    expect(f.logs.join("\n")).toMatch(/update check/);
  });

  it("gives up on the update check after the timeout and uses the cache", async () => {
    await cache(f.home, "v0.2.0");
    f.deps.tagsTimeoutMs = 30;
    f.deps.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;

    const started = Date.now();
    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("uses the cache when GitHub refuses the tags request (rate limit)", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = new Response('{"message":"API rate limit exceeded"}', { status: 403 });

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
  });

  it("keeps no half-extracted version when the download is not a tarball, and falls back", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", Buffer.from("this is not gzip"));

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(existsSync(join(f.home, "versions", "v0.4.0"))).toBe(false);
    expect(existsSync(join(f.home, "tmp")) ? await readdir(join(f.home, "tmp")) : []).toEqual([]);
  });

  it("rejects a tarball without the bundled bridge", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", { "README.md": "hi" }));

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(existsSync(join(f.home, "versions", "v0.4.0"))).toBe(false);
  });

  it("ignores tags from before the self-contained bundle (below v0.2.0)", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.1.9", "v0.1.0");

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(f.fetched).toEqual([TAGS_URL]);
  });

  it("keeps the two newest versions and deletes older ones", async () => {
    for (const tag of ["v0.2.0", "v0.2.1", "v0.3.0"]) await cache(f.home, tag);
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", goodFiles("v0.4.0")));

    await prepareVersion(f.deps);

    expect((await readdir(join(f.home, "versions"))).sort()).toEqual(["v0.3.0", "v0.4.0"]);
  });

  it("returns nothing when nothing is cached and the download fails", async () => {
    f.tags = new TypeError("fetch failed");
    expect(await prepareVersion(f.deps)).toBeUndefined();
  });

  it("skips the network entirely when update checks are off", async () => {
    await cache(f.home, "v0.2.0");
    f.deps.checkForUpdates = false;

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(f.fetched).toEqual([]);
  });

  it("re-copies the picked version's skill into each installed client's skill folder, once per version", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.2.0");
    const claudeSkill = join(f.root, "claude", "skills", "tripezgo");
    const codexSkill = join(f.root, "agents", "skills", "tripezgo");
    await mkdir(claudeSkill, { recursive: true });
    await writeFile(join(claudeSkill, "SKILL.md"), "old skill");
    await writeFile(
      join(f.home, "config.json"),
      JSON.stringify({
        clients: { "claude-code": { skillDir: claudeSkill }, codex: { skillDir: codexSkill }, "claude-desktop": {} },
      }),
    );

    await prepareVersion(f.deps);

    expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toBe("skill v0.2.0");
    expect(await readFile(join(codexSkill, "SKILL.md"), "utf8")).toBe("skill v0.2.0");
    expect(await readFile(join(codexSkill, ".tripezgo-version"), "utf8")).toBe("v0.2.0\n");

    // Same version again: the folder is current and stays as it is.
    await writeFile(join(claudeSkill, "sentinel"), "x");
    await prepareVersion(f.deps);
    expect(existsSync(join(claudeSkill, "sentinel"))).toBe(true);

    // A newer version replaces it.
    f.tags = tagList("v0.2.1");
    f.tarballs.set("v0.2.1", await tarball(f.root, "v0.2.1", goodFiles("v0.2.1")));
    await prepareVersion(f.deps);
    expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toBe("skill v0.2.1");
    expect(existsSync(join(claudeSkill, "sentinel"))).toBe(false);
  });
});
