/**
 * `~/.tripezgo/launcher.mjs` — the command every AI client is configured with (absolute node + this file, no
 * arguments). It never changes after install; everything it runs comes from `~/.tripezgo/versions/<tag>`,
 * which it keeps current from this repo's release tags. Zero dependencies, Node 18+.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENTRY, prepareVersion } from "./launcherCore.js";

const log = (message: string) => process.stderr.write(`tripezgo-launcher: ${message}\n`);

const picked = await prepareVersion({
  home: dirname(fileURLToPath(import.meta.url)),
  fetch,
  log,
  checkForUpdates: process.env.TRIPEZGO_NO_UPDATE !== "1",
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
