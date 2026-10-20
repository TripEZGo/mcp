import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareTags, parseTag, readInstallConfig, readMarker, replaceDir } from "./fsutil.js";
import { SignatureError, verifyMinisign } from "./signature.js";

/**
 * What `~/.tripezgo/launcher.mjs` does on every start, before the bridge runs: find the newest release, cache
 * it, refresh the installed skill folders. Every failure here falls back to what is already cached. Nothing
 * is written to stdout: that is the MCP channel, and the bridge owns it.
 */

export const REPO = "TripEZGo/mcp";
export const TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=100`;
/**
 * The signed release tarball is a release asset (GitHub's own tag tarballs are generated on demand and can't be
 * signed), and `<name>.minisig` is its minisign signature.
 */
export const tarballName = (tag: string) => `tripezgo-mcp-${tag}.tar.gz`;
export const tarballUrl = (tag: string) => `https://github.com/${REPO}/releases/download/${tag}/${tarballName(tag)}`;
export const signatureUrl = (tag: string) => `${tarballUrl(tag)}.minisig`;
/**
 * The only key a downloaded release may be signed with (minisign public-key line; the private half stays with
 * the maintainer). A launcher never switches to a tarball this key didn't sign.
 */
export const RELEASE_PUBLIC_KEY = "RWQOXh+Dq2IvfnB0D/U1BP3InZrPeHJ5BR8j6p6hllSgROq2+meR7aAn";
/** The first release whose tarball runs without `npm install`. */
export const MIN_TAG = "v0.2.0";
/** The file that proves a cached version is complete. */
export const ENTRY = join("dist", "cli.js");
const KEEP_VERSIONS = 2;

export interface LauncherDeps {
  /** `~/.tripezgo`: `versions/`, `tmp/`, `config.json`. */
  home: string;
  fetch: typeof fetch;
  log: (message: string) => void;
  /** Extracts a .tar.gz into an existing folder. Defaults to the system `tar`. */
  extract?: (archive: string, dest: string) => Promise<void>;
  /** False skips the network (TRIPEZGO_NO_UPDATE=1). */
  checkForUpdates?: boolean;
  /**
   * Starts `updateCache` somewhere that doesn't hold up this start (the real launcher: a detached child
   * process). Called only when a cached version is about to run.
   */
  startBackgroundUpdate?: () => void;
  tagsTimeoutMs?: number;
  downloadTimeoutMs?: number;
  /** Where releases come from; GitHub unless overridden (TRIPEZGO_UPDATE_BASE, for testing a release). */
  sources?: ReleaseSources;
  /** Overrides `RELEASE_PUBLIC_KEY`; for tests only. */
  publicKey?: string;
}

export interface ReleaseSources {
  tags: string;
  tarball: (tag: string) => string;
  signature: (tag: string) => string;
}

/** The GitHub API + codeload URL shapes under another origin, e.g. a local stand-in server. */
export function sourcesAt(base: string): ReleaseSources {
  const root = base.replace(/\/+$/, "");
  return {
    tags: `${root}/repos/${REPO}/tags?per_page=100`,
    tarball: (tag) => `${root}/${REPO}/releases/download/${tag}/${tarballName(tag)}`,
    signature: (tag) => `${root}/${REPO}/releases/download/${tag}/${tarballName(tag)}.minisig`,
  };
}

export interface PickedVersion {
  tag: string;
  dir: string;
}

/**
 * Picks the version to run, without waiting on the network: the newest cached one runs at once, and the update
 * check runs in the background so a newer release applies on the next start. Only with nothing cached at all
 * does it check and download in the foreground.
 */
export async function prepareVersion(deps: LauncherDeps): Promise<PickedVersion | undefined> {
  const versions = join(deps.home, "versions");
  let cached = await cachedTags(versions);

  if (cached.length === 0) {
    if (deps.checkForUpdates === false) return undefined;
    await updateCache(deps);
    cached = await cachedTags(versions);
    if (cached.length === 0) return undefined;
  } else if (deps.checkForUpdates !== false) {
    try {
      deps.startBackgroundUpdate?.();
    } catch (error) {
      deps.log(`couldn't start the background update (${describe(error)})`);
    }
  }

  const picked: PickedVersion = { tag: cached[0], dir: join(versions, cached[0]) };
  await syncSkills(deps, picked);
  return picked;
}

/**
 * Checks the release tags (short timeout) and, when the newest isn't cached, downloads it. Then keeps the two
 * newest versions. Every failure leaves the cache as it was.
 */
export async function updateCache(deps: LauncherDeps): Promise<string | undefined> {
  const versions = join(deps.home, "versions");
  const latest = await latestTag(deps);
  const newestCached = (await cachedTags(versions))[0];
  // Only something newer than what already runs is worth a download (an install can be ahead of the tags).
  if (latest && (!newestCached || compareTags(latest, newestCached) > 0)) {
    try {
      await download(deps, latest);
      deps.log(`downloaded ${latest}; it runs from the next start`);
    } catch (error) {
      deps.log(`couldn't download ${latest} (${describe(error)}); keeping the cached version`);
    }
  }
  for (const old of (await cachedTags(versions)).slice(KEEP_VERSIONS)) {
    await rm(join(versions, old), { recursive: true, force: true }).catch(() => undefined);
  }
  await sweepStaleTemp(join(deps.home, "tmp"));
  return latest;
}

async function latestTag(deps: LauncherDeps): Promise<string | undefined> {
  try {
    const response = await deps.fetch(deps.sources?.tags ?? TAGS_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "tripezgo-launcher" },
      signal: AbortSignal.timeout(deps.tagsTimeoutMs ?? 2_000),
    });
    if (!response.ok) {
      deps.log(`update check: GitHub answered HTTP ${response.status}`);
      return undefined;
    }
    const body: unknown = await response.json();
    const tags = Array.isArray(body)
      ? body
          .map((entry) => (entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined))
          .filter((name): name is string => typeof name === "string" && !!parseTag(name) && compareTags(name, MIN_TAG) >= 0)
      : [];
    return tags.sort(compareTags).at(-1);
  } catch (error) {
    deps.log(`update check failed (${describe(error)}); using the cached version`);
    return undefined;
  }
}

/** Downloads and extracts beside the cache, then renames into place: a version folder is whole or absent. */
async function download(deps: LauncherDeps, tag: string): Promise<void> {
  const temp = join(deps.home, "tmp", `${tag}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(join(temp, "x"), { recursive: true });
    const fetchAsset = async (url: string) => {
      const response = await deps.fetch(url, {
        headers: { "User-Agent": "tripezgo-launcher" },
        signal: AbortSignal.timeout(deps.downloadTimeoutMs ?? 20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response;
    };
    const bytes = new Uint8Array(await (await fetchAsset(deps.sources?.tarball(tag) ?? tarballUrl(tag))).arrayBuffer());
    const signature = await (await fetchAsset(deps.sources?.signature(tag) ?? signatureUrl(tag))).text();
    // Nothing is extracted, let alone run, until the maintainer's key has signed exactly these bytes.
    try {
      verifyMinisign(bytes, signature, deps.publicKey ?? RELEASE_PUBLIC_KEY);
    } catch (error) {
      if (error instanceof SignatureError) throw new Error(`signature check failed: ${error.message}`);
      throw error;
    }
    const archive = join(temp, "release.tar.gz");
    await writeFile(archive, bytes);
    await (deps.extract ?? systemTar)(archive, join(temp, "x"));

    const tops = await readdir(join(temp, "x"));
    if (tops.length !== 1) throw new Error("unexpected tarball layout");
    const extracted = join(temp, "x", tops[0]);
    if (!isComplete(extracted)) throw new Error(`the release has no ${ENTRY}`);

    const target = join(deps.home, "versions", tag);
    await mkdir(join(deps.home, "versions"), { recursive: true });
    try {
      await rename(extracted, target);
    } catch (error) {
      // Another client started at the same moment and won the race: its copy is as good as ours.
      if (!isComplete(target)) throw error;
    }
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function systemTar(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xzf", archive, "-C", dest], (error, _stdout, stderr) => {
      if (error) reject(new Error(`tar: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

/** Leftovers of a launcher that was killed mid-download. Recent ones may belong to a launcher running now. */
async function sweepStaleTemp(tmp: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(tmp);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    try {
      if ((await stat(join(tmp, name))).mtimeMs < cutoff) await rm(join(tmp, name), { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}

function isComplete(dir: string): boolean {
  return existsSync(join(dir, ENTRY));
}

/** Complete cached versions, newest first. */
async function cachedTags(versions: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(versions);
  } catch {
    return [];
  }
  const complete: string[] = [];
  for (const name of names) {
    if (!parseTag(name)) continue;
    try {
      if ((await stat(join(versions, name))).isDirectory() && isComplete(join(versions, name))) complete.push(name);
    } catch {
      // vanished under us
    }
  }
  return complete.sort(compareTags).reverse();
}

/** Each installed client's skill folder gets this version's `skills/tripezgo`, unless it already has it. */
async function syncSkills(deps: LauncherDeps, picked: PickedVersion): Promise<void> {
  const source = join(picked.dir, "skills", "tripezgo");
  if (!existsSync(source)) return;
  const config = await readInstallConfig(join(deps.home, "config.json"));
  for (const [client, entry] of Object.entries(config.clients)) {
    const skillDir = entry && typeof entry.skillDir === "string" ? entry.skillDir : undefined;
    if (!skillDir) continue;
    if ((await readMarker(skillDir)) === picked.tag) continue;
    try {
      await replaceDir(source, skillDir, picked.tag);
      deps.log(`${client}: skill updated to ${picked.tag}`);
    } catch (error) {
      deps.log(`${client}: couldn't update the skill at ${skillDir} (${describe(error)})`);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    const cause = (error as Error & { cause?: { code?: unknown } }).cause;
    return cause?.code ? `${error.message}: ${String(cause.code)}` : error.message;
  }
  return String(error);
}
