/**
 * `~/.tripezgo/launcher.mjs` — the command every AI client is configured with (absolute node + this file, no
 * arguments). It never changes after install; everything it runs comes from `~/.tripezgo/versions/<tag>`,
 * which it keeps current from this repo's release tags. Zero dependencies, Node 18+.
 *
 * Start: run the newest cached version at once, and check for a newer release in a detached background
 * process (`launcher.mjs --update`) that only fills the cache; the new version runs from the next start.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENTRY, prepareVersion, sourcesAt, updateCache } from "./launcherCore.js";

const self = fileURLToPath(import.meta.url);
const home = dirname(self);
const sources = process.env.TRIPEZGO_UPDATE_BASE ? sourcesAt(process.env.TRIPEZGO_UPDATE_BASE) : undefined;

if (process.argv[2] === "--update") {
  // The background updater: nobody reads its stdio, so it writes to a log file.
  const log = (message: string) => {
    try {
      appendFileSync(join(home, "update.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // nowhere to say it
    }
  };
  await updateCache({ home, fetch, log, sources });
  process.exit(0);
}

const log = (message: string) => process.stderr.write(`tripezgo-launcher: ${message}\n`);

const picked = await prepareVersion({
  home,
  fetch,
  log,
  sources,
  checkForUpdates: process.env.TRIPEZGO_NO_UPDATE !== "1",
  startBackgroundUpdate: () => {
    const child = spawn(process.execPath, [self, "--update"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => log(`background update didn't start (${error.message})`));
    child.unref();
  },
});

if (!picked) {
  log(
    "no TripEZGo bridge is cached and the download failed. Connect to the internet and restart the AI app, " +
      "or run: npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>",
  );
  process.exit(1);
}

log(`running ${picked.tag}`);
// Same process, stdio untouched: the bridge reads stdin and writes stdout itself.
await import(pathToFileURL(join(picked.dir, ENTRY)).href);
