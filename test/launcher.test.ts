import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LauncherDeps, TAGS_URL, prepareVersion, signatureUrl, sourcesAt, tarballUrl, updateCache } from "../src/launcherCore.js";
import { type TestKey, testKey } from "./signing.js";

interface Fixture {
  root: string;
  home: string;
  fetched: string[];
  logs: string[];
  tags: unknown;
  tarballs: Map<string, Buffer>;
  /** A signature file to serve for a tag instead of the valid one. */
  signatures: Map<string, string>;
  key: TestKey;
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
    signatures: new Map(),
    key: testKey(),
    deps: undefined as unknown as LauncherDeps,
  };
  f.deps = {
    home,
    publicKey: f.key.publicKey,
    log: (m) => f.logs.push(m),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      f.fetched.push(url);
      if (url === TAGS_URL) {
        if (f.tags instanceof Error) throw f.tags;
        if (f.tags instanceof Response) return f.tags;
        return new Response(JSON.stringify(f.tags), { status: 200 });
      }
      const signed = [...f.tarballs].find(([tag]) => url === signatureUrl(tag));
      if (signed) {
        // Signed as the release script does, unless a test stages another signature.
        const text = f.signatures.get(signed[0]) ?? f.key.sign(signed[1]);
        return new Response(text, { status: 200 });
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

describe("prepareVersion: what runs now", () => {
  let f: Fixture;
  let background: number;
  beforeEach(async () => {
    f = await fixture();
    background = 0;
    f.deps.startBackgroundUpdate = () => background++;
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  it("runs the newest cached version at once — no network — and leaves the update check to the background", async () => {
    await cache(f.home, "v0.2.0");
    await cache(f.home, "v0.3.0");
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", goodFiles("v0.4.0")));

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.3.0");
    expect(f.fetched).toEqual([]);
    expect(background).toBe(1);

    // The background run fills the cache; the next start runs the new version.
    await updateCache(f.deps);
    expect((await prepareVersion(f.deps))?.tag).toBe("v0.4.0");
  });

  it("starts no background update when update checks are off", async () => {
    await cache(f.home, "v0.2.0");
    f.deps.checkForUpdates = false;

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(background).toBe(0);
    expect(f.fetched).toEqual([]);
  });

  it("still runs the cached version when the background update can't start", async () => {
    await cache(f.home, "v0.2.0");
    f.deps.startBackgroundUpdate = () => {
      throw new Error("spawn EAGAIN");
    };

    expect((await prepareVersion(f.deps))?.tag).toBe("v0.2.0");
    expect(f.logs.join("\n")).toMatch(/EAGAIN/);
  });

  it("downloads in the foreground only when nothing is cached at all", async () => {
    f.tags = tagList("v0.2.0", "v0.10.0", "v0.3.0", "latest", "v1.0.0-beta");
    f.tarballs.set("v0.10.0", await tarball(f.root, "v0.10.0", goodFiles("v0.10.0")));

    const picked = await prepareVersion(f.deps);

    expect(picked).toEqual({ tag: "v0.10.0", dir: join(f.home, "versions", "v0.10.0") });
    expect(f.fetched).toEqual([TAGS_URL, tarballUrl("v0.10.0"), signatureUrl("v0.10.0")]);
    expect(background).toBe(0);
  });

  it("returns nothing when nothing is cached and the download fails, or update checks are off", async () => {
    f.tags = new TypeError("fetch failed");
    expect(await prepareVersion(f.deps)).toBeUndefined();
    f.deps.checkForUpdates = false;
    expect(await prepareVersion(f.deps)).toBeUndefined();
  });

  it("copies the version it runs into each installed client's skill folder, once per version", async () => {
    await cache(f.home, "v0.2.0");
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

    // A newer version downloaded in the background: its skill arrives with the start that runs it, not before.
    f.tags = tagList("v0.2.1");
    f.tarballs.set("v0.2.1", await tarball(f.root, "v0.2.1", goodFiles("v0.2.1")));
    await updateCache(f.deps);
    expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toBe("skill v0.2.0");
    await prepareVersion(f.deps);
    expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toBe("skill v0.2.1");
    expect(existsSync(join(claudeSkill, "sentinel"))).toBe(false);
  });
});

describe("updateCache: the background update", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  const cachedNow = async () => (await readdir(join(f.home, "versions")).catch(() => [])).sort();
  const tmpLeft = async () => (existsSync(join(f.home, "tmp")) ? await readdir(join(f.home, "tmp")) : []);

  it("downloads the highest semver tag into versions/<tag> and leaves no temp folder behind", async () => {
    f.tags = tagList("v0.2.0", "v0.10.0", "v0.3.0", "latest", "v1.0.0-beta");
    f.tarballs.set("v0.10.0", await tarball(f.root, "v0.10.0", goodFiles("v0.10.0")));

    expect(await updateCache(f.deps)).toBe("v0.10.0");

    expect(await readFile(join(f.home, "versions", "v0.10.0", "dist", "cli.js"), "utf8")).toBe("// cli v0.10.0");
    expect(f.fetched).toEqual([TAGS_URL, tarballUrl("v0.10.0"), signatureUrl("v0.10.0")]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("uses the release source it is given", async () => {
    const sources = sourcesAt("http://127.0.0.1:1/");
    f.deps.sources = sources;
    f.tags = new TypeError("fetch failed");
    await updateCache(f.deps);
    expect(f.fetched).toEqual(["http://127.0.0.1:1/repos/TripEZGo/mcp/tags?per_page=100"]);
    expect(sources.tarball("v1.2.3")).toBe("http://127.0.0.1:1/TripEZGo/mcp/releases/download/v1.2.3/tripezgo-mcp-v1.2.3.tar.gz");
  });

  it("doesn't download a release older than one already cached (a local install ahead of the newest tag)", async () => {
    await cache(f.home, "v0.2.1");
    f.tags = tagList("v0.2.0");
    f.tarballs.set("v0.2.0", await tarball(f.root, "v0.2.0", goodFiles("v0.2.0")));

    await updateCache(f.deps);
    expect(f.fetched).toEqual([TAGS_URL]);
    expect(await cachedNow()).toEqual(["v0.2.1"]);
  });

  it("doesn't download a tag already in the cache", async () => {
    await cache(f.home, "v0.3.0");
    f.tags = tagList("v0.3.0");

    await updateCache(f.deps);
    expect(f.fetched).toEqual([TAGS_URL]);
  });

  it("changes nothing when offline, rate-limited, or too slow", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = new TypeError("fetch failed");
    await updateCache(f.deps);
    f.tags = new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    await updateCache(f.deps);
    f.deps.tagsTimeoutMs = 30;
    f.deps.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    await updateCache(f.deps);
    expect(Date.now() - started).toBeLessThan(2000);

    expect(await cachedNow()).toEqual(["v0.2.0"]);
    expect(f.logs.join("\n")).toMatch(/update check/);
  });

  it("keeps no half-extracted version when the download is not a tarball", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", Buffer.from("this is not gzip"));

    await updateCache(f.deps);
    expect(await cachedNow()).toEqual(["v0.2.0"]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("keeps the cached version and says why when the signature is from another key", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    const archive = await tarball(f.root, "v0.4.0", goodFiles("v0.4.0"));
    f.tarballs.set("v0.4.0", archive);
    f.signatures.set("v0.4.0", testKey().sign(archive));

    await updateCache(f.deps);
    expect(await cachedNow()).toEqual(["v0.2.0"]);
    expect(f.logs.join("\n")).toMatch(/signature check failed: signed with a different key/);
    expect(await tmpLeft()).toEqual([]);
  });

  it("keeps the cached version when the tarball was altered after signing", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    const archive = await tarball(f.root, "v0.4.0", goodFiles("v0.4.0"));
    f.signatures.set("v0.4.0", f.key.sign(archive));
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", { ...goodFiles("v0.4.0"), "dist/cli.js": "// evil" }));

    await updateCache(f.deps);
    expect(await cachedNow()).toEqual(["v0.2.0"]);
    expect(f.logs.join("\n")).toMatch(/signature check failed: the signature does not match the file/);
  });

  it("keeps the cached version when the release has no signature", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", goodFiles("v0.4.0")));
    f.deps.fetch = (async (input: string | URL | Request) =>
      String(input) === signatureUrl("v0.4.0") ? new Response("nope", { status: 404 }) : Response.json(tagList("v0.4.0"))) as typeof fetch;

    await updateCache(f.deps);
    expect(await cachedNow()).toEqual(["v0.2.0"]);
  });

  it("rejects a tarball without the bundled bridge", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", { "README.md": "hi" }));

    await updateCache(f.deps);
    expect(await cachedNow()).toEqual(["v0.2.0"]);
  });

  it("ignores tags from before the self-contained bundle (below v0.2.0)", async () => {
    await cache(f.home, "v0.2.0");
    f.tags = tagList("v0.1.9", "v0.1.0");

    await updateCache(f.deps);
    expect(f.fetched).toEqual([TAGS_URL]);
  });

  it("keeps the two newest versions and deletes older ones", async () => {
    for (const tag of ["v0.2.0", "v0.2.1", "v0.3.0"]) await cache(f.home, tag);
    f.tags = tagList("v0.4.0");
    f.tarballs.set("v0.4.0", await tarball(f.root, "v0.4.0", goodFiles("v0.4.0")));

    await updateCache(f.deps);
    expect(await cachedNow()).toEqual(["v0.3.0", "v0.4.0"]);
  });
});
