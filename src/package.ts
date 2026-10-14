import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, type Tool } from "./protocol.js";

/**
 * The folder holding `package.json`, `skills/` and `snapshot/`. Both `src/*.ts` and the bundled
 * `dist/cli.js` sit one level below it.
 */
export function packageRootOf(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

export function packageVersion(root: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return isObject(pkg) && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SNAPSHOT_PATH = join("snapshot", "app-tools.json");
export const SKILL_PATH = join("skills", "tripezgo");

/**
 * The app's tools as of this release (`snapshot/app-tools.json`, written by `scripts/sync-app-tools.mjs`).
 * Listed before a connection exists, because some clients never re-read the tool list later.
 */
export function loadAppToolSnapshot(root: string, log?: (message: string) => void): Tool[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, SNAPSHOT_PATH), "utf8"));
    if (isObject(value) && Array.isArray(value.tools)) {
      return value.tools.filter((tool): tool is Tool => isObject(tool) && typeof tool.name === "string" && isObject(tool.inputSchema));
    }
    log?.(`${SNAPSHOT_PATH} has no tools array; listing only the local tools`);
  } catch (error) {
    log?.(`can't read ${SNAPSHOT_PATH} (${(error as Error).message}); listing only the local tools`);
  }
  return [];
}
