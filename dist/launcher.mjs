#!/usr/bin/env node
// TripEZGo launcher: https://github.com/TripEZGo/mcp — updates itself from the release tags.

// src/launcher.ts
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/launcherCore.ts
import { execFile } from "node:child_process";
import { randomBytes as randomBytes2 } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir as mkdir2, readdir, rename as rename2, rm as rm2, stat, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/fsutil.ts
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
var SKILL_MARKER = ".tripezgo-version";
function siblingTemp(path) {
  return join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}
async function replaceDir(src, dest, marker) {
  await mkdir(dirname(dest), { recursive: true });
  const temp = siblingTemp(dest);
  try {
    await cp(src, temp, { recursive: true });
    if (marker !== void 0) await writeFile(join(temp, SKILL_MARKER), `${marker}
`);
    await rm(dest, { recursive: true, force: true });
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
async function readMarker(dir) {
  try {
    return (await readFile(join(dir, SKILL_MARKER), "utf8")).trim();
  } catch {
    return void 0;
  }
}
async function readInstallConfig(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const clients = value.clients;
      if (clients && typeof clients === "object" && !Array.isArray(clients)) {
        return { ...value, clients };
      }
    }
  } catch {
  }
  return { clients: {} };
}
function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : void 0;
}
function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

// src/signature.ts
import { createHash, createPublicKey, verify } from "node:crypto";
var SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
var TRUSTED_COMMENT = "trusted comment: ";
var SignatureError = class extends Error {
};
function parsePublicKey(base64) {
  const raw = Buffer.from(base64.trim(), "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") throw new SignatureError("not a minisign public key");
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}
function verifyMinisign(message, signatureFile, publicKey) {
  const pub = parsePublicKey(publicKey);
  const lines = signatureFile.split(/\r?\n/);
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith(TRUSTED_COMMENT)) {
    throw new SignatureError("the signature file is malformed");
  }
  const sig = Buffer.from(lines[1].trim(), "base64");
  const globalSig = Buffer.from(lines[3].trim(), "base64");
  if (sig.length !== 74 || globalSig.length !== 64) throw new SignatureError("the signature file is malformed");
  const algorithm = sig.toString("latin1", 0, 2);
  if (algorithm !== "Ed" && algorithm !== "ED") throw new SignatureError("unknown signature algorithm");
  if (!sig.subarray(2, 10).equals(pub.keyId)) throw new SignatureError("signed with a different key");
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub.key]), format: "der", type: "spki" });
  const signed = algorithm === "ED" ? createHash("blake2b512").update(message).digest() : Buffer.from(message);
  if (!verify(null, signed, key, sig.subarray(10))) throw new SignatureError("the signature does not match the file");
  const trusted = Buffer.from(lines[2].slice(TRUSTED_COMMENT.length), "utf8");
  if (!verify(null, Buffer.concat([sig.subarray(10), trusted]), key, globalSig)) {
    throw new SignatureError("the trusted comment was altered");
  }
}

// src/launcherCore.ts
var REPO = "TripEZGo/mcp";
var TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=100`;
var tarballName = (tag) => `tripezgo-mcp-${tag}.tar.gz`;
var tarballUrl = (tag) => `https://github.com/${REPO}/releases/download/${tag}/${tarballName(tag)}`;
var signatureUrl = (tag) => `${tarballUrl(tag)}.minisig`;
var RELEASE_PUBLIC_KEY = "RWQOXh+Dq2IvfnB0D/U1BP3InZrPeHJ5BR8j6p6hllSgROq2+meR7aAn";
var MIN_TAG = "v0.2.0";
var ENTRY = join2("dist", "cli.js");
var KEEP_VERSIONS = 2;
function sourcesAt(base) {
  const root = base.replace(/\/+$/, "");
  return {
    tags: `${root}/repos/${REPO}/tags?per_page=100`,
    tarball: (tag) => `${root}/${REPO}/releases/download/${tag}/${tarballName(tag)}`,
    signature: (tag) => `${root}/${REPO}/releases/download/${tag}/${tarballName(tag)}.minisig`
  };
}
async function prepareVersion(deps) {
  const versions = join2(deps.home, "versions");
  let cached = await cachedTags(versions);
  if (cached.length === 0) {
    if (deps.checkForUpdates === false) return void 0;
    await updateCache(deps);
    cached = await cachedTags(versions);
    if (cached.length === 0) return void 0;
  } else if (deps.checkForUpdates !== false) {
    try {
      deps.startBackgroundUpdate?.();
    } catch (error) {
      deps.log(`couldn't start the background update (${describe(error)})`);
    }
  }
  const picked2 = { tag: cached[0], dir: join2(versions, cached[0]) };
  await syncSkills(deps, picked2);
  return picked2;
}
async function updateCache(deps) {
  const versions = join2(deps.home, "versions");
  const latest = await latestTag(deps);
  const newestCached = (await cachedTags(versions))[0];
  if (latest && (!newestCached || compareTags(latest, newestCached) > 0)) {
    try {
      await download(deps, latest);
      deps.log(`downloaded ${latest}; it runs from the next start`);
    } catch (error) {
      deps.log(`couldn't download ${latest} (${describe(error)}); keeping the cached version`);
    }
  }
  for (const old of (await cachedTags(versions)).slice(KEEP_VERSIONS)) {
    await rm2(join2(versions, old), { recursive: true, force: true }).catch(() => void 0);
  }
  await sweepStaleTemp(join2(deps.home, "tmp"));
  return latest;
}
async function latestTag(deps) {
  try {
    const response = await deps.fetch(deps.sources?.tags ?? TAGS_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "tripezgo-launcher" },
      signal: AbortSignal.timeout(deps.tagsTimeoutMs ?? 2e3)
    });
    if (!response.ok) {
      deps.log(`update check: GitHub answered HTTP ${response.status}`);
      return void 0;
    }
    const body = await response.json();
    const tags = Array.isArray(body) ? body.map((entry) => entry && typeof entry === "object" ? entry.name : void 0).filter((name) => typeof name === "string" && !!parseTag(name) && compareTags(name, MIN_TAG) >= 0) : [];
    return tags.sort(compareTags).at(-1);
  } catch (error) {
    deps.log(`update check failed (${describe(error)}); using the cached version`);
    return void 0;
  }
}
async function download(deps, tag) {
  const temp = join2(deps.home, "tmp", `${tag}-${process.pid}-${randomBytes2(4).toString("hex")}`);
  try {
    await mkdir2(join2(temp, "x"), { recursive: true });
    const fetchAsset = async (url) => {
      const response = await deps.fetch(url, {
        headers: { "User-Agent": "tripezgo-launcher" },
        signal: AbortSignal.timeout(deps.downloadTimeoutMs ?? 2e4)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response;
    };
    const bytes = new Uint8Array(await (await fetchAsset(deps.sources?.tarball(tag) ?? tarballUrl(tag))).arrayBuffer());
    const signature = await (await fetchAsset(deps.sources?.signature(tag) ?? signatureUrl(tag))).text();
    try {
      verifyMinisign(bytes, signature, deps.publicKey ?? RELEASE_PUBLIC_KEY);
    } catch (error) {
      if (error instanceof SignatureError) throw new Error(`signature check failed: ${error.message}`);
      throw error;
    }
    const archive = join2(temp, "release.tar.gz");
    await writeFile2(archive, bytes);
    await (deps.extract ?? systemTar)(archive, join2(temp, "x"));
    const tops = await readdir(join2(temp, "x"));
    if (tops.length !== 1) throw new Error("unexpected tarball layout");
    const extracted = join2(temp, "x", tops[0]);
    if (!isComplete(extracted)) throw new Error(`the release has no ${ENTRY}`);
    const target = join2(deps.home, "versions", tag);
    await mkdir2(join2(deps.home, "versions"), { recursive: true });
    try {
      await rename2(extracted, target);
    } catch (error) {
      if (!isComplete(target)) throw error;
    }
  } finally {
    await rm2(temp, { recursive: true, force: true }).catch(() => void 0);
  }
}
function systemTar(archive, dest) {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xzf", archive, "-C", dest], (error, _stdout, stderr) => {
      if (error) reject(new Error(`tar: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}
async function sweepStaleTemp(tmp) {
  let names;
  try {
    names = await readdir(tmp);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1e3;
  for (const name of names) {
    try {
      if ((await stat(join2(tmp, name))).mtimeMs < cutoff) await rm2(join2(tmp, name), { recursive: true, force: true });
    } catch {
    }
  }
}
function isComplete(dir) {
  return existsSync(join2(dir, ENTRY));
}
async function cachedTags(versions) {
  let names;
  try {
    names = await readdir(versions);
  } catch {
    return [];
  }
  const complete = [];
  for (const name of names) {
    if (!parseTag(name)) continue;
    try {
      if ((await stat(join2(versions, name))).isDirectory() && isComplete(join2(versions, name))) complete.push(name);
    } catch {
    }
  }
  return complete.sort(compareTags).reverse();
}
async function syncSkills(deps, picked2) {
  const source = join2(picked2.dir, "skills", "tripezgo");
  if (!existsSync(source)) return;
  const config = await readInstallConfig(join2(deps.home, "config.json"));
  for (const [client, entry] of Object.entries(config.clients)) {
    const skillDir = entry && typeof entry.skillDir === "string" ? entry.skillDir : void 0;
    if (!skillDir) continue;
    if (await readMarker(skillDir) === picked2.tag) continue;
    try {
      await replaceDir(source, skillDir, picked2.tag);
      deps.log(`${client}: skill updated to ${picked2.tag}`);
    } catch (error) {
      deps.log(`${client}: couldn't update the skill at ${skillDir} (${describe(error)})`);
    }
  }
}
function describe(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    const cause = error.cause;
    return cause?.code ? `${error.message}: ${String(cause.code)}` : error.message;
  }
  return String(error);
}

// src/launcher.ts
var self = fileURLToPath(import.meta.url);
var home = dirname2(self);
var sources = process.env.TRIPEZGO_UPDATE_BASE ? sourcesAt(process.env.TRIPEZGO_UPDATE_BASE) : void 0;
if (process.argv[2] === "--update") {
  const log2 = (message) => {
    try {
      appendFileSync(join3(home, "update.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
    } catch {
    }
  };
  await updateCache({ home, fetch, log: log2, sources });
  process.exit(0);
}
var log = (message) => process.stderr.write(`tripezgo-launcher: ${message}
`);
var picked = await prepareVersion({
  home,
  fetch,
  log,
  sources,
  checkForUpdates: process.env.TRIPEZGO_NO_UPDATE !== "1",
  startBackgroundUpdate: () => {
    const child = spawn(process.execPath, [self, "--update"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => log(`background update didn't start (${error.message})`));
    child.unref();
  }
});
if (!picked) {
  log(
    "no TripEZGo bridge is cached and the download failed. Connect to the internet and restart the AI app, or run: npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>"
  );
  process.exit(1);
}
log(`running ${picked.tag}`);
await import(pathToFileURL(join3(picked.dir, ENTRY)).href);
