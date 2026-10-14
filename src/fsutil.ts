import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Shared by the installer and the launcher: nothing they write is ever seen half-written. */

export const SKILL_MARKER = ".tripezgo-version";

function siblingTemp(path: string): string {
  return join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}

export async function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = siblingTemp(path);
  try {
    await writeFile(temp, data, mode === undefined ? undefined : { mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Replaces `dest` with a copy of `src`: the copy is made beside it first, so a failure leaves the old folder.
 * `marker` (the version) is written into the copy so later runs can tell it is current.
 */
export async function replaceDir(src: string, dest: string, marker?: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const temp = siblingTemp(dest);
  try {
    await cp(src, temp, { recursive: true });
    if (marker !== undefined) await writeFile(join(temp, SKILL_MARKER), `${marker}\n`);
    await rm(dest, { recursive: true, force: true });
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function readMarker(dir: string): Promise<string | undefined> {
  try {
    return (await readFile(join(dir, SKILL_MARKER), "utf8")).trim();
  } catch {
    return undefined;
  }
}

/** `~/.tripezgo/config.json`: which clients were installed, and where each one's skill folder is. */
export interface InstallConfig {
  clients: Record<string, { skillDir?: string; installedAt?: string }>;
}

export async function readInstallConfig(path: string): Promise<InstallConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const clients = (value as { clients?: unknown }).clients;
      if (clients && typeof clients === "object" && !Array.isArray(clients)) {
        return { ...(value as object), clients: clients as InstallConfig["clients"] };
      }
    }
  } catch {
    // Missing or unreadable: start over.
  }
  return { clients: {} };
}

/** `v1.2.3` → [1, 2, 3]; anything else → undefined. */
export function parseTag(tag: string): [number, number, number] | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareTags(a: string, b: string): number {
  const x = parseTag(a)!;
  const y = parseTag(b)!;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
