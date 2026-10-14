// Bundles the bridge (with the installer) and the launcher into single files that run from a tag tarball
// with no `npm install`: dist/cli.js and dist/launcher.mjs. Both are committed.
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(dist, "cli.js"),
  // The shebang in src/cli.ts is carried over by esbuild.
});

await build({
  ...common,
  entryPoints: [join(root, "src", "launcher.ts")],
  outfile: join(dist, "launcher.mjs"),
  banner: { js: "#!/usr/bin/env node\n// TripEZGo launcher: https://github.com/TripEZGo/mcp — updates itself from the release tags." },
});
